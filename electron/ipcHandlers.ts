// ipcHandlers.ts

import { ipcMain, shell, dialog } from "electron"
import { randomBytes } from "crypto"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { IIpcHandlerDeps } from "./main"
import { configHelper } from "./ConfigHelper"

function resolveClaudeExecutable(): string {
  const override = process.env.CLAUDE_CLI_PATH;
  if (override && fs.existsSync(override)) return override;
  const home = os.homedir();
  const candidates = process.platform === "win32"
    ? [
        path.join(home, ".local", "bin", "claude.exe"),
        path.join(home, "AppData", "Roaming", "npm", "claude.cmd"),
      ]
    : [
        path.join(home, ".local", "bin", "claude"),
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
      ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "claude";
}

interface CliTestResult {
  ok: boolean;
  executable: string;
  version?: string;
  ping?: string;
  error?: string;
  stage?: "version" | "ping";
}

function runOnce(executable: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }, timeoutMs);
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnError: err.code === "ENOENT" ? "ENOENT" : err.message });
    });
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function initializeIpcHandlers(deps: IIpcHandlerDeps): void {
  console.log("Initializing IPC handlers")

  // Configuration handlers
  ipcMain.handle("get-config", () => {
    return configHelper.loadConfig();
  })

  ipcMain.handle("update-config", (_event, updates) => {
    return configHelper.updateConfig(updates);
  })

  ipcMain.handle("check-api-key", () => {
    return configHelper.hasApiKey();
  })
  
  ipcMain.handle("validate-api-key", async (_event, apiKey) => {
    // First check the format
    if (!configHelper.isValidApiKeyFormat(apiKey)) {
      return {
        valid: false,
        error: "Invalid API key format. OpenAI API keys start with 'sk-'"
      };
    }

    // Then test the API key with OpenAI
    const result = await configHelper.testApiKey(apiKey);
    return result;
  })

  // Claude Code CLI: probe `claude --version` then a minimal prompt to confirm
  // both that the binary is reachable AND that the user's subscription session
  // is active (no "please run /login" wall).
  ipcMain.handle("test-claude-cli", async (): Promise<CliTestResult> => {
    const executable = resolveClaudeExecutable();

    const versionRun = await runOnce(executable, ["--version"], 15000);
    if (versionRun.spawnError === "ENOENT") {
      return {
        ok: false,
        executable,
        stage: "version",
        error: `Could not find the Claude Code CLI. Tried: ${executable}. Install it from https://docs.claude.com/en/docs/claude-code, or set the CLAUDE_CLI_PATH environment variable to its full path.`,
      };
    }
    if (versionRun.spawnError) {
      return { ok: false, executable, stage: "version", error: `Failed to launch: ${versionRun.spawnError}` };
    }
    if (versionRun.code !== 0) {
      return {
        ok: false,
        executable,
        stage: "version",
        error: `\`claude --version\` exited with code ${versionRun.code}. Stderr: ${versionRun.stderr.trim().slice(0, 300)}`,
      };
    }
    const version = versionRun.stdout.trim();

    const pingRun = await runOnce(
      executable,
      ["-p", "Reply with exactly the word OK and nothing else.", "--output-format", "json", "--model", "haiku", "--permission-mode", "bypassPermissions"],
      60000,
    );
    if (pingRun.code !== 0) {
      return {
        ok: false,
        executable,
        version,
        stage: "ping",
        error: `Test prompt failed (exit ${pingRun.code}). The CLI is installed but your session may not be authenticated — try running \`claude\` in a terminal and signing in. Stderr: ${pingRun.stderr.trim().slice(0, 300)}`,
      };
    }
    try {
      const parsed = JSON.parse(pingRun.stdout);
      if (parsed && typeof parsed.result === "string" && !parsed.is_error) {
        return { ok: true, executable, version, ping: parsed.result.trim() };
      }
      return {
        ok: false,
        executable,
        version,
        stage: "ping",
        error: parsed?.result || parsed?.error || "Test prompt returned an error response.",
      };
    } catch (err: any) {
      return {
        ok: false,
        executable,
        version,
        stage: "ping",
        error: `Could not parse CLI JSON output: ${err.message}`,
      };
    }
  })

  // Reports the actual screen-capture protection state of the live window.
  // Used by Settings to give the user a clear "you are invisible to capture" signal.
  ipcMain.handle("check-capture-protection", () => {
    const mainWindow = deps.getMainWindow();
    const winVer = process.platform === "win32" ? os.release() : "";
    // Win10 2004+ (build 19041) supports WDA_EXCLUDEFROMCAPTURE.
    const buildNum = winVer ? Number(winVer.split(".")[2] || 0) : 0;
    const supportsExcludeFromCapture =
      process.platform === "darwin" ||
      (process.platform === "win32" && buildNum >= 19041);
    return {
      platform: process.platform,
      windowExists: !!mainWindow,
      // Electron's setContentProtection is one-way; we re-assert it here in
      // case anything cleared it, then report success.
      protectionApplied: !!mainWindow && (() => {
        try { mainWindow.setContentProtection(true); return true; } catch { return false; }
      })(),
      supportsExcludeFromCapture,
      windowsBuild: buildNum || undefined,
    };
  })

  // Credits handlers
  ipcMain.handle("set-initial-credits", async (_event, credits: number) => {
    const mainWindow = deps.getMainWindow()
    if (!mainWindow) return

    try {
      // Set the credits in a way that ensures atomicity
      await mainWindow.webContents.executeJavaScript(
        `window.__CREDITS__ = ${credits}`
      )
      mainWindow.webContents.send("credits-updated", credits)
    } catch (error) {
      console.error("Error setting initial credits:", error)
      throw error
    }
  })

  ipcMain.handle("decrement-credits", async () => {
    const mainWindow = deps.getMainWindow()
    if (!mainWindow) return

    try {
      const currentCredits = await mainWindow.webContents.executeJavaScript(
        "window.__CREDITS__"
      )
      if (currentCredits > 0) {
        const newCredits = currentCredits - 1
        await mainWindow.webContents.executeJavaScript(
          `window.__CREDITS__ = ${newCredits}`
        )
        mainWindow.webContents.send("credits-updated", newCredits)
      }
    } catch (error) {
      console.error("Error decrementing credits:", error)
    }
  })

  // Screenshot queue handlers
  ipcMain.handle("get-screenshot-queue", () => {
    return deps.getScreenshotQueue()
  })

  ipcMain.handle("get-extra-screenshot-queue", () => {
    return deps.getExtraScreenshotQueue()
  })

  ipcMain.handle("delete-screenshot", async (event, path: string) => {
    return deps.deleteScreenshot(path)
  })

  ipcMain.handle("get-image-preview", async (event, path: string) => {
    return deps.getImagePreview(path)
  })

  // Screenshot processing handlers
  ipcMain.handle("process-screenshots", async () => {
    // Check for API key before processing
    if (!configHelper.hasApiKey()) {
      const mainWindow = deps.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send(deps.PROCESSING_EVENTS.API_KEY_INVALID);
      }
      return;
    }
    
    await deps.processingHelper?.processScreenshots()
  })

  // Window dimension handlers
  ipcMain.handle(
    "update-content-dimensions",
    async (event, { width, height }: { width: number; height: number }) => {
      if (width && height) {
        deps.setWindowDimensions(width, height)
      }
    }
  )

  ipcMain.handle(
    "set-window-dimensions",
    (event, width: number, height: number) => {
      deps.setWindowDimensions(width, height)
    }
  )

  // Screenshot management handlers
  ipcMain.handle("get-screenshots", async () => {
    try {
      let previews = []
      const currentView = deps.getView()

      if (currentView === "queue") {
        const queue = deps.getScreenshotQueue()
        previews = await Promise.all(
          queue.map(async (path) => ({
            path,
            preview: await deps.getImagePreview(path)
          }))
        )
      } else {
        const extraQueue = deps.getExtraScreenshotQueue()
        previews = await Promise.all(
          extraQueue.map(async (path) => ({
            path,
            preview: await deps.getImagePreview(path)
          }))
        )
      }

      return previews
    } catch (error) {
      console.error("Error getting screenshots:", error)
      throw error
    }
  })

  // Screenshot trigger handlers
  ipcMain.handle("trigger-screenshot", async () => {
    const mainWindow = deps.getMainWindow()
    if (mainWindow) {
      try {
        const screenshotPath = await deps.takeScreenshot()
        const preview = await deps.getImagePreview(screenshotPath)
        mainWindow.webContents.send("screenshot-taken", {
          path: screenshotPath,
          preview
        })
        return { success: true }
      } catch (error) {
        console.error("Error triggering screenshot:", error)
        return { error: "Failed to trigger screenshot" }
      }
    }
    return { error: "No main window available" }
  })

  ipcMain.handle("take-screenshot", async () => {
    try {
      const screenshotPath = await deps.takeScreenshot()
      const preview = await deps.getImagePreview(screenshotPath)
      return { path: screenshotPath, preview }
    } catch (error) {
      console.error("Error taking screenshot:", error)
      return { error: "Failed to take screenshot" }
    }
  })

  // Auth-related handlers removed

  ipcMain.handle("open-external-url", (event, url: string) => {
    shell.openExternal(url)
  })
  
  // Open external URL handler
  ipcMain.handle("openLink", (event, url: string) => {
    try {
      console.log(`Opening external URL: ${url}`);
      shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error(`Error opening URL ${url}:`, error);
      return { success: false, error: `Failed to open URL: ${error}` };
    }
  })

  // Settings portal handler
  ipcMain.handle("open-settings-portal", () => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send("show-settings-dialog");
      return { success: true };
    }
    return { success: false, error: "Main window not available" };
  })

  // Window management handlers
  ipcMain.handle("toggle-window", () => {
    try {
      deps.toggleMainWindow()
      return { success: true }
    } catch (error) {
      console.error("Error toggling window:", error)
      return { error: "Failed to toggle window" }
    }
  })

  ipcMain.handle("reset-queues", async () => {
    try {
      deps.clearQueues()
      return { success: true }
    } catch (error) {
      console.error("Error resetting queues:", error)
      return { error: "Failed to reset queues" }
    }
  })

  // Process screenshot handlers
  ipcMain.handle("trigger-process-screenshots", async () => {
    try {
      // Check for API key before processing
      if (!configHelper.hasApiKey()) {
        const mainWindow = deps.getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(deps.PROCESSING_EVENTS.API_KEY_INVALID);
        }
        return { success: false, error: "API key required" };
      }
      
      await deps.processingHelper?.processScreenshots()
      return { success: true }
    } catch (error) {
      console.error("Error processing screenshots:", error)
      return { error: "Failed to process screenshots" }
    }
  })

  // Reset handlers
  ipcMain.handle("trigger-reset", () => {
    try {
      // First cancel any ongoing requests
      deps.processingHelper?.cancelOngoingRequests()

      // Clear all queues immediately
      deps.clearQueues()

      // Reset view to queue
      deps.setView("queue")

      // Get main window and send reset events
      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        // Send reset events in sequence
        mainWindow.webContents.send("reset-view")
        mainWindow.webContents.send("reset")
      }

      return { success: true }
    } catch (error) {
      console.error("Error triggering reset:", error)
      return { error: "Failed to trigger reset" }
    }
  })

  // Window movement handlers
  ipcMain.handle("trigger-move-left", () => {
    try {
      deps.moveWindowLeft()
      return { success: true }
    } catch (error) {
      console.error("Error moving window left:", error)
      return { error: "Failed to move window left" }
    }
  })

  ipcMain.handle("trigger-move-right", () => {
    try {
      deps.moveWindowRight()
      return { success: true }
    } catch (error) {
      console.error("Error moving window right:", error)
      return { error: "Failed to move window right" }
    }
  })

  ipcMain.handle("trigger-move-up", () => {
    try {
      deps.moveWindowUp()
      return { success: true }
    } catch (error) {
      console.error("Error moving window up:", error)
      return { error: "Failed to move window up" }
    }
  })

  ipcMain.handle("trigger-move-down", () => {
    try {
      deps.moveWindowDown()
      return { success: true }
    } catch (error) {
      console.error("Error moving window down:", error)
      return { error: "Failed to move window down" }
    }
  })
  
  // Delete last screenshot handler
  ipcMain.handle("delete-last-screenshot", async () => {
    try {
      const queue = deps.getView() === "queue" 
        ? deps.getScreenshotQueue() 
        : deps.getExtraScreenshotQueue()
      
      if (queue.length === 0) {
        return { success: false, error: "No screenshots to delete" }
      }
      
      // Get the last screenshot in the queue
      const lastScreenshot = queue[queue.length - 1]
      
      // Delete it
      const result = await deps.deleteScreenshot(lastScreenshot)
      
      // Notify the renderer about the change
      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("screenshot-deleted", { path: lastScreenshot })
      }
      
      return result
    } catch (error) {
      console.error("Error deleting last screenshot:", error)
      return { success: false, error: "Failed to delete last screenshot" }
    }
  })
}

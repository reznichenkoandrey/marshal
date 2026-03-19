import type { ToolExecutionResult, ToolName } from "../core/protocol.ts";
import { FileSandbox } from "./fs.ts";
import { ShellTool } from "./shell.ts";
import { BrowserTool } from "./browser.ts";

export class Toolbox {
  fileSandbox: FileSandbox;
  shellTool: ShellTool;
  browserTool: BrowserTool;

  constructor(fileSandbox: FileSandbox, shellTool: ShellTool, browserTool: BrowserTool) {
    this.fileSandbox = fileSandbox;
    this.shellTool = shellTool;
    this.browserTool = browserTool;
  }

  async execute(action: ToolName, input: Record<string, unknown>): Promise<ToolExecutionResult> {
    switch (action) {
      case "read_file": {
        const result = await this.fileSandbox.readFile(String(input.path));
        return {
          ok: true,
          tool: action,
          summary: `Read file ${result.path}`,
          data: result
        };
      }
      case "write_file": {
        const result = await this.fileSandbox.writeFile(String(input.path), String(input.content));
        return {
          ok: true,
          tool: action,
          summary: `Wrote file ${result.path}`,
          data: result
        };
      }
      case "list_dir": {
        const result = await this.fileSandbox.listDir(String(input.path));
        return {
          ok: true,
          tool: action,
          summary: `Listed directory ${result.path}`,
          data: result
        };
      }
      case "run_shell": {
        const result = await this.shellTool.run(String(input.cmd));
        return {
          ok: true,
          tool: action,
          summary: `Executed shell command ${result.cmd}`,
          data: result
        };
      }
      case "browser_navigate": {
        const result = await this.browserTool.navigate(String(input.url));
        return {
          ok: true,
          tool: action,
          summary: `Navigated to ${result.url}`,
          data: result
        };
      }
      case "browser_click": {
        const result = await this.browserTool.click(String(input.selector));
        return {
          ok: true,
          tool: action,
          summary: `Clicked selector ${result.selector}`,
          data: result
        };
      }
      case "browser_type": {
        const result = await this.browserTool.type(String(input.selector), String(input.text));
        return {
          ok: true,
          tool: action,
          summary: `Typed into ${result.selector}`,
          data: result
        };
      }
      default:
        throw new Error(`Unsupported tool action: ${action}`);
    }
  }
}

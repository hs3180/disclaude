import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SKILL_DIR = path.resolve(__dirname, "..");
const SCRIPT_PATH = path.join(SKILL_DIR, "scripts", "mac_control.py");

describe("mac-control skill", () => {
  describe("file structure", () => {
    it("should have SKILL.md", () => {
      expect(fs.existsSync(path.join(SKILL_DIR, "SKILL.md"))).toBe(true);
    });

    it("should have the main Python script", () => {
      expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
    });

    it("should have a well-formed SKILL.md with required frontmatter", () => {
      const skillMd = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf-8");
      expect(skillMd).toContain("name: mac-control");
      expect(skillMd).toContain("description:");
      expect(skillMd).toContain("allowed-tools:");
    });

    it("SKILL.md should document all API commands", () => {
      const skillMd = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf-8");
      const expectedCommands = [
        "click", "double_click", "right_click", "drag", "move",
        "type_text", "key",
        "screenshot", "screenshot_region",
        "get_frontmost_app", "activate_app", "get_window_bounds", "list_windows",
        "get_scale_factor", "screen_to_logical", "logical_to_screen", "get_mouse_position",
      ];
      for (const cmd of expectedCommands) {
        expect(skillMd).toContain(`\`${cmd}\``);
      }
    });
  });

  describe("Python script", () => {
    it("should be valid Python syntax", () => {
      const script = fs.readFileSync(SCRIPT_PATH, "utf-8");
      expect(script.startsWith("#!/usr/bin/env python3")).toBe(true);
      expect(script).toContain('platform.system() != "Darwin"');
      expect(script).toContain("def main():");

      const commandFunctions = [
        "cmd_click", "cmd_double_click", "cmd_right_click",
        "cmd_move", "cmd_drag",
        "cmd_type_text", "cmd_key",
        "cmd_screenshot", "cmd_screenshot_region",
        "cmd_get_frontmost_app", "cmd_activate_app",
        "cmd_get_window_bounds", "cmd_list_windows",
        "cmd_get_scale_factor", "cmd_screen_to_logical",
        "cmd_logical_to_screen", "cmd_get_mouse_position",
      ];
      for (const fn of commandFunctions) {
        expect(script).toContain(`def ${fn}`);
      }
    });

    it("should use CGEvent via ctypes (no external dependencies)", () => {
      const script = fs.readFileSync(SCRIPT_PATH, "utf-8");
      expect(script).toContain("ctypes.cdll.LoadLibrary");
      expect(script).toContain("CoreGraphics");
      expect(script).toContain("CGEventCreateMouseEvent");
      expect(script).toContain("CGEventCreateKeyboardEvent");
    });

    it("should implement clipboard paste for text input", () => {
      const script = fs.readFileSync(SCRIPT_PATH, "utf-8");
      expect(script).toContain("pbcopy");
      expect(script).toContain("pbpaste");
      expect(script).toContain("old_clipboard");
    });

    it("should handle Retina display scaling", () => {
      const script = fs.readFileSync(SCRIPT_PATH, "utf-8");
      expect(script).toContain("backingScaleFactor");
      expect(script).toContain("cmd_get_scale_factor");
      expect(script).toContain("screen_to_logical");
      expect(script).toContain("logical_to_screen");
    });

    it("should have a command router mapping all commands", () => {
      const script = fs.readFileSync(SCRIPT_PATH, "utf-8");
      expect(script).toContain("COMMANDS = {");
      const expectedCommands = [
        "click", "double_click", "right_click", "drag", "move",
        "type_text", "key",
        "screenshot", "screenshot_region",
        "get_frontmost_app", "activate_app", "get_window_bounds", "list_windows",
        "get_scale_factor", "screen_to_logical", "logical_to_screen", "get_mouse_position",
      ];
      for (const cmd of expectedCommands) {
        expect(script).toContain(`"${cmd}"`);
      }
    });

    it("should output JSON for errors", () => {
      const script = fs.readFileSync(SCRIPT_PATH, "utf-8");
      expect(script).toContain('"error":');
      expect(script).toContain('"error": str(e)');
    });
  });

  describe("command coverage", () => {
    it("SKILL.md and script should have matching command sets", () => {
      const script = fs.readFileSync(SCRIPT_PATH, "utf-8");
      const skillMd = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf-8");

      const commandsMatch = script.match(/COMMANDS\s*=\s*\{([^}]+)\}/s);
      expect(commandsMatch).not.toBeNull();
      const commandsSection = commandsMatch![1];
      const scriptCommands = [...commandsSection.matchAll(/"(\w+)"/g)].map(m => m[1]);

      for (const cmd of scriptCommands) {
        expect(skillMd).toContain(`\`${cmd}\``);
      }
    });
  });
});

/**
 * Type definitions for Mac screen control automation.
 *
 * Issue #2216: Provides TypeScript interfaces for macOS accessibility
 * automation — screenshot, mouse, keyboard, and UI element control.
 *
 * Implementation uses shell commands (screencapture, osascript, pbcopy)
 * rather than native bindings, keeping the module pure TypeScript.
 *
 * @module mac-control/types
 */

// ─── Geometry ───────────────────────────────────────────────────────

/** A 2D point in logical (points) coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** A rectangle defined by origin and dimensions (logical points). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─── Screenshot ─────────────────────────────────────────────────────

export interface ScreenshotOptions {
  /** Crop to a specific region (logical points). */
  region?: Rect;
  /** Include the cursor in the capture (default: false). */
  cursor?: boolean;
  /** Write screenshot to file path instead of returning Buffer. */
  filePath?: string;
}

export interface ScreenshotResult {
  success: boolean;
  /** PNG buffer when no filePath was specified. */
  buffer?: Buffer;
  /** File path when filePath was specified. */
  filePath?: string;
  error?: string;
}

// ─── Mouse ──────────────────────────────────────────────────────────

export type MouseButton = 'left' | 'right';

export interface ClickOptions {
  /** Mouse button (default: 'left'). */
  button?: MouseButton;
  /** Number of clicks — 1 for single, 2 for double (default: 1). */
  clickCount?: number;
  /** Delay in milliseconds before the click (default: 0). */
  delay?: number;
}

export interface DragOptions {
  /** Duration of the drag in seconds (default: 0.5). */
  duration?: number;
  /** Delay before the drag starts in milliseconds (default: 0). */
  delay?: number;
}

// ─── Keyboard ───────────────────────────────────────────────────────

export type ModifierKey = 'command' | 'cmd' | 'shift' | 'option' | 'alt' | 'control' | 'ctrl' | 'fn';

export interface TypeOptions {
  /** Inter-key delay in milliseconds (default: 20). */
  interval?: number;
  /** Use clipboard paste for non-ASCII text instead of keystroke injection (default: true). */
  useClipboard?: boolean;
}

// ─── UI Element (Accessibility API) ─────────────────────────────────

export type AXRole =
  | 'AXWindow' | 'AXButton' | 'AXTextField' | 'AXStaticText'
  | 'AXCheckBox' | 'AXRadioButton' | 'AXMenu' | 'AXMenuItem'
  | 'AXPopUpButton' | 'AXTable' | 'AXRow' | 'AXColumn'
  | 'AXScrollArea' | 'AXGroup' | 'AXSheet' | 'AXDialog';

export interface UIElement {
  /** Accessibility role (e.g. AXButton). */
  role: AXRole | string;
  /** Element title / label. */
  title?: string;
  /** Element value (e.g. text field contents). */
  value?: string;
  /** Bounding rect in logical points relative to screen origin. */
  rect: Rect;
  /** Whether the element is enabled for interaction. */
  enabled?: boolean;
  /** Child elements (only populated when depth > 0). */
  children?: UIElement[];
}

export interface QueryElementOptions {
  /** Maximum depth to traverse (default: 0 = flat). */
  depth?: number;
  /** Filter by role (e.g. 'AXButton'). */
  role?: string;
  /** Filter by title substring. */
  titleContains?: string;
}

// ─── Application ────────────────────────────────────────────────────

export interface ApplicationInfo {
  name: string;
  bundleId: string;
  /** Whether the app is currently frontmost. */
  frontmost: boolean;
  /** Window bounds in logical points (if available). */
  windowBounds?: Rect;
}

// ─── Main API ───────────────────────────────────────────────────────

/**
 * Mac screen control API.
 *
 * All coordinates are in **logical points** (not pixels).
 * For Retina displays, logical points = pixel coordinates / backingScaleFactor.
 *
 * @example
 * ```ts
 * const mac = new MacControl();
 *
 * // Take screenshot
 * const shot = await mac.screenshot();
 *
 * // Click at coordinates (from screenshot analysis)
 * await mac.click(500, 300);
 *
 * // Type Chinese text via clipboard
 * await mac.type('你好世界');
 * ```
 */
export interface MacControlAPI {
  // Screenshot
  screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>;

  // Mouse
  click(x: number, y: number, options?: ClickOptions): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  rightClick(x: number, y: number): Promise<void>;
  drag(from: Point, to: Point, options?: DragOptions): Promise<void>;
  move(x: number, y: number): Promise<void>;
  /** Get current mouse position in logical points. */
  getMousePosition(): Promise<Point>;

  // Keyboard
  type(text: string, options?: TypeOptions): Promise<void>;
  key(key: string, modifiers?: ModifierKey[]): Promise<void>;
  /** Press a keyboard shortcut (e.g. key('v', ['cmd'])). */
  shortcut(key: string, modifiers: ModifierKey[]): Promise<void>;

  // UI Elements (Accessibility API)
  /** Query UI elements of the frontmost application. */
  queryElements(options?: QueryElementOptions): Promise<UIElement[]>;
  /** Get the focused/selected UI element. */
  getFocusedElement(): Promise<UIElement | null>;

  // Application
  /** Get the frontmost application info. */
  getFrontmostApp(): Promise<ApplicationInfo>;
  /** Activate (bring to front) an application by name or bundle ID. */
  activateApp(nameOrBundleId: string): Promise<void>;
}

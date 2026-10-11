using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace ToolWheel
{
    /// Server-admin settings, read from ModToolWheel.json next to the DLL.
    /// Every field has a default, so a missing file or a missing key is fine.
    public sealed class ToolWheelConfig
    {
        // ---- Opening ----
        /// Key that opens the wheel: a JavaScript keyCode ("220"), one letter or digit ("G"), or "\\".
        /// The HUD's key events carry only keyCode (key and code are undefined), so the
        /// client matches on the code. Tap to toggle; hold, aim and release to pick.
        /// Default "4". Digit keys do reach the HUD, but a digit is also DU's own "tool bar slot N"
        /// binding; the client undoes that stock switch when the key opens the wheel. Unbinding the
        /// slot key in DU's Controls settings avoids the switch altogether.
        public string Hotkey { get; set; } = "4";
        /// false = icon / right-click menu only.
        public bool EnableHotkey { get; set; } = true;
        /// Opt-in: hold Alt (more than 150 ms, no other key) to open, aim, release to pick.
        /// Off by default because Alt is a modifier in stock key combos.
        public bool HoldAlt { get; set; } = false;
        /// Quick-select keys, one per wedge in wheel order: while the wheel is open, pressing the
        /// key of a wedge equips that tool at once and closes the wheel. Same forms as Hotkey, plus
        /// "-" and "=". Wedge 1 gets the first key, and so on; a wedge past the end of the list has
        /// no key. Digits also match the numpad. An empty list turns quick-select off.
        public List<string> QuickKeys { get; set; } = DefaultQuickKeys();
        public static List<string> DefaultQuickKeys() => new() { "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=" };
        /// Adds the "TW" icon to the HUD notification bar; clicking it opens the wheel.
        public bool ShowHudIcon { get; set; } = true;

        // ---- Contents ----
        /// Group shown until the client has detected the game's mode (roaming or build): "explore" or "build".
        public string DefaultBar { get; set; } = "explore";
        /// false = the tools in the player's nanopack (the stock set); true = every enabled tool
        /// in the item bank, owned or not.
        public bool ShowAllTools { get; set; } = false;

        // ---- Tool selection ----
        /// The stock bar slot (1-9) the wheel loads tools into. With SingleSlotBar on, it is the
        /// ONLY occupied slot of each tool bar. With it off, a tool not on the bar goes to the first
        /// empty slot, and to this slot when the bar is full.
        public int LoadSlot { get; set; } = 9;
        /// Keep the stock tool bars (roaming and build) empty except for LoadSlot: each wheel pick
        /// loads the tool into LoadSlot and clears every other slot (toolBar.resetItem). The stock
        /// slot keys 1-9 cannot be blocked from script; with the other slots empty, a stray key
        /// selects nothing, and the wheel puts the tool back in hand.
        public bool SingleSlotBar { get; set; } = true;

        // ---- Stock tool bar and inventory ----
        /// Hide the stock TOOL bar (the wheel replaces it). The consumable bar stays. The bar still
        /// exists logically, so selecting and loading tools keep working.
        public bool HideStockBar { get; set; } = true;
        /// Hide the wheel's tools in the inventory / nanopack window, client side only (the items stay).
        /// Off by default: the inventory grid is virtualized and re-renders its entries while
        /// scrolling, so a hidden tool shows again for a moment on every re-render (10-09 test).
        /// No stylesheet rule can hide an entry from its icon (that needs :has()). Experimental.
        public bool HideToolsInInventory { get; set; } = false;
        /// Hide the tools from the inventory screen for real: at login (and from the menu action
        /// Tool Wheel > Hide tools) every tool below HiddenSlotBase is moved to a nanopack slot at
        /// or above it, which the grid does not draw. The items stay in the nanopack, so the wheel
        /// still loads them. Tool Wheel > Unhide tools moves them back and keeps them visible for
        /// that player until the next Hide tools.
        public bool HideToolsInNanopack { get; set; } = true;
        /// First slot of the hidden range. Raised to the grid size (nanopackMaxSlots) if lower.
        public int HiddenSlotBase { get; set; } = 1000;

        // ---- Injection ----
        /// Seconds after login at which the script is (re)sent until the client confirms it loaded.
        /// The client drops injections that arrive before its HUD is ready.
        public List<double> InjectDelaysSeconds { get; set; } = new() { 3, 8, 15, 30, 60, 120, 240 };
        /// Optional override of the embedded client script (for iterating without a rebuild).
        public string ScriptOverridePath { get; set; } = "/OrleansGrains/Mods/ToolWheel/toolwheel.js";

        // ---- Debug ----
        /// Client logs key events, toolbar engine events and every select attempt to its console
        /// (client log, "ConsoleAPI" lines) and forwards them to Grains_dev.log.
        public bool Debug { get; set; } = false;
        /// Max debug lines per player per minute forwarded to the server log.
        public int DebugForwardPerMinute { get; set; } = 120;

        public static string DefaultPath =>
            Environment.GetEnvironmentVariable("TOOLWHEEL_CONFIG") ?? "/OrleansGrains/Mods/ModToolWheel.json";

        public static (ToolWheelConfig cfg, string source) Load(string path)
        {
            if (!File.Exists(path))
                return (new ToolWheelConfig(), "defaults (no config file at " + path + ")");
            var cfg = Parse(File.ReadAllText(path));
            return (cfg, path);
        }

        public static ToolWheelConfig Parse(string json)
        {
            var opts = new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
                ReadCommentHandling = JsonCommentHandling.Skip,
                AllowTrailingCommas = true,
            };
            var cfg = JsonSerializer.Deserialize<ToolWheelConfig>(json, opts) ?? new ToolWheelConfig();
            cfg.Sanitize();
            return cfg;
        }

        public void Sanitize()
        {
            Hotkey = string.IsNullOrWhiteSpace(Hotkey) ? "4" : Hotkey.Trim();
            DefaultBar = string.Equals(DefaultBar, "build", StringComparison.OrdinalIgnoreCase) ? "build" : "explore";
            if (LoadSlot < 1 || LoadSlot > 9) LoadSlot = 9;
            if (HiddenSlotBase < 1 || HiddenSlotBase > 32000) HiddenSlotBase = 1000;
            InjectDelaysSeconds ??= new();
            InjectDelaysSeconds.RemoveAll(d => d < 0 || double.IsNaN(d));
            if (InjectDelaysSeconds.Count == 0) InjectDelaysSeconds.Add(5);
            QuickKeys ??= DefaultQuickKeys();
            QuickKeys = QuickKeys.Select(k => (k ?? "").Trim()).ToList();
            if (DebugForwardPerMinute < 0) DebugForwardPerMinute = 0;
        }

        /// JavaScript keyCode for a hotkey setting: a number is taken as is, one letter or digit
        /// maps to its upper-case char code (the browser keyCode for those keys), and "\\" is 220.
        public static int HotkeyCode(string hotkey)
        {
            var h = (hotkey ?? "").Trim();
            if (h == "\\")
                return 220;
            if (h.Length > 1 && int.TryParse(h, out var code) && code > 0 && code < 256)
                return code;
            if (h.Length == 1 && char.IsLetterOrDigit(h[0]) && h[0] < 128)
                return char.ToUpperInvariant(h[0]);
            return 0;
        }

        /// keyCode for a quick-select key: "-" is 189 and "=" is 187 (the browser keyCodes the
        /// HUD reports); anything else as HotkeyCode. 0 = not a usable key (that wedge gets none).
        public static int QuickKeyCode(string key)
        {
            var k = (key ?? "").Trim();
            if (k == "-") return 189;
            if (k == "=") return 187;
            return HotkeyCode(k);
        }

        /// Which wedge a keyCode selects, or -1. The client script does the same lookup
        /// (quickIndex in toolwheel.js): digits also match their numpad key (96-105), and "-" / "="
        /// also match the alternate codes some engines send (173 / 61).
        public static int QuickKeyIndex(IReadOnlyList<int> codes, int keyCode, int toolCount)
        {
            if (codes == null || keyCode <= 0) return -1;
            for (var i = 0; i < codes.Count && i < toolCount; i++)
            {
                var c = codes[i];
                if (c <= 0) continue;
                if (c == keyCode
                    || (c >= 48 && c <= 57 && keyCode == c + 48)
                    || (c == 189 && keyCode == 173)
                    || (c == 187 && keyCode == 61))
                    return i;
            }
            return -1;
        }

        /// The subset the client script needs, as JSON.
        public string ClientJson() => JsonSerializer.Serialize(new
        {
            hotkey = Hotkey,
            enableHotkey = EnableHotkey,
            holdAlt = HoldAlt,
            showHudIcon = ShowHudIcon,
            hotkeyCode = HotkeyCode(Hotkey),
            defaultBar = DefaultBar,
            loadSlot = LoadSlot - 1,
            singleSlot = SingleSlotBar,
            hideStockBar = HideStockBar,
            hideToolsInInventory = HideToolsInInventory,
            debug = Debug,
            quickKeys = QuickKeys.Select(k => new { label = k, code = QuickKeyCode(k) }).ToList(),
        });
    }
}

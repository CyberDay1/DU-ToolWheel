using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace ToolWheel
{
    /// Per-player hotkeys, chosen in the wheel (hub > Hotkey) or from Tool Wheel > Set hotkey.
    /// Stored server-side in Mods/ToolWheel/player-hotkeys.json as {"<playerId>": keyCode}; a
    /// player with no entry uses the config Hotkey. The HUD reports keyCode only, so a keyCode is
    /// what is stored. Pure logic only; MyDuMod does the file and the HUD events.
    public static class PlayerHotkeys
    {
        /// Why a keyCode cannot be a hotkey, or null when it can. The client runs the same list
        /// (hotkeyRefusal in toolwheel.js) so the prompt can answer at once; the server decides.
        public static string Refusal(int code)
        {
            if (code <= 0 || code > 255) return "not a key";
            switch (code)
            {
                case 27: return "Esc cancels";
                case 8: return "Backspace resets the hotkey in the prompt";
                case 9: return "Tab toggles the cursor";
                case 13: return "Enter opens the chat";
                case 16: case 17: case 18: return "modifier keys cannot be the hotkey";
                case 20: case 144: case 145: return "lock keys cannot be the hotkey";
                case 91: case 92: case 93: return "the Windows and menu keys do not stay in the game";
                case 44: return "Print Screen takes screenshots";
                case 71: return "G is the holster key, which the wheel already handles";
                case 87: case 65: case 83: case 68: case 32: return "a movement key would open the wheel while moving";
            }
            return null;
        }

        /// Short label for a keyCode, as shown in the wheel ("4", "G", "\\", "F5", "Num 4").
        /// Same table as hotkeyLabel in toolwheel.js.
        public static string Label(int code)
        {
            if (code >= 48 && code <= 57) return ((char)code).ToString();
            if (code >= 65 && code <= 90) return ((char)code).ToString();
            if (code >= 96 && code <= 105) return "Num " + (code - 96);
            if (code >= 112 && code <= 123) return "F" + (code - 111);
            switch (code)
            {
                case 106: return "Num *";
                case 107: return "Num +";
                case 109: return "Num -";
                case 110: return "Num .";
                case 111: return "Num /";
                case 186: return ";";
                case 187: case 61: return "=";
                case 188: return ",";
                case 189: case 173: return "-";
                case 190: return ".";
                case 191: return "/";
                case 192: return "`";
                case 219: return "[";
                case 220: return "\\";
                case 221: return "]";
                case 222: return "'";
                case 33: return "PgUp";
                case 34: return "PgDn";
                case 35: return "End";
                case 36: return "Home";
                case 45: return "Ins";
                case 46: return "Del";
                case 37: return "Left";
                case 38: return "Up";
                case 39: return "Right";
                case 40: return "Down";
            }
            return "key " + code;
        }

        /// A note for a key that is accepted but also does something else, or null. A quick key
        /// keeps its wedge role while the wheel is open (the open wheel picks that wedge, Esc
        /// closes it); a digit 1-9 is also a stock tool bar slot key, which the wheel undoes.
        public static string Note(int code, IReadOnlyList<int> quickCodes)
        {
            var notes = new List<string>();
            int qi = ToolWheelConfig.QuickKeyIndex(quickCodes, code, quickCodes?.Count ?? 0);
            if (qi >= 0)
                notes.Add("it is also wedge " + (qi + 1) + "'s quick key: with the wheel open it equips that tool, so close with Esc");
            if (code >= 49 && code <= 57)
                notes.Add("it is also the stock tool bar slot " + (code - 48) + " key; the wheel undoes that switch");
            return notes.Count == 0 ? null : string.Join("; ", notes);
        }

        /// The hotkey a player has: their own when set, else the config one.
        public static int Effective(IReadOnlyDictionary<ulong, int> chosen, ulong playerId, int configCode) =>
            chosen != null && chosen.TryGetValue(playerId, out var c) && c > 0 ? c : configCode;

        /// What the client sends with action 103: "set:<keyCode>" or "reset".
        /// Returns (reset, code); code is 0 when the payload is not understood.
        public static (bool reset, int code) ParseRequest(string payload)
        {
            var p = (payload ?? "").Trim();
            if (p == "reset") return (true, 0);
            if (p.StartsWith("set:", StringComparison.Ordinal) && int.TryParse(p.Substring(4), out var c))
                return (false, c);
            return (false, 0);
        }

        /// Reads player-hotkeys.json. Entries with a non-numeric id or a refused code are dropped.
        public static Dictionary<ulong, int> Parse(string json)
        {
            var result = new Dictionary<ulong, int>();
            if (string.IsNullOrWhiteSpace(json)) return result;
            var raw = JsonSerializer.Deserialize<Dictionary<string, int>>(json) ?? new Dictionary<string, int>();
            foreach (var kv in raw)
                if (ulong.TryParse(kv.Key, out var id) && Refusal(kv.Value) == null)
                    result[id] = kv.Value;
            return result;
        }

        public static string Serialize(IReadOnlyDictionary<ulong, int> chosen) =>
            JsonSerializer.Serialize(chosen.OrderBy(kv => kv.Key).ToDictionary(kv => kv.Key.ToString(), kv => kv.Value),
                new JsonSerializerOptions { WriteIndented = true });
    }
}

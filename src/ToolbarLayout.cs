using System;
using System.Collections.Generic;
using System.Globalization;

namespace ToolWheel
{
    /// The player's stock toolbar as the server stores it (player.toolbar, via IPlayerGrain.GetToolbar).
    /// Observed format (ver 1.01):
    ///   ver: 1.01
    ///   build:
    ///     bar:
    ///       - 823239531,0,0,0
    ///   explore:
    ///     bar:
    ///       - 2687779164,0,0,0
    ///       - 0,0,0,0
    /// Each "- " line is one slot in order; the first number is the item type id (0 = empty).
    /// Other sections (Fuel, Honeycomb, ...) are per-item-category bars and are kept but unused.
    public static class ToolbarLayout
    {
        public static Dictionary<string, List<ulong>> Parse(string content)
        {
            var bars = new Dictionary<string, List<ulong>>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrEmpty(content))
                return bars;
            string section = null;
            bool inBar = false;
            foreach (var raw in content.Split('\n'))
            {
                var line = raw.TrimEnd('\r');
                if (line.Trim().Length == 0)
                    continue;
                int indent = line.Length - line.TrimStart().Length;
                var t = line.Trim();
                if (indent == 0)
                {
                    inBar = false;
                    section = t.EndsWith(":") ? t.Substring(0, t.Length - 1).Trim() : null;
                    continue;
                }
                if (section == null)
                    continue;
                if (t == "bar:")
                {
                    inBar = true;
                    if (!bars.ContainsKey(section))
                        bars[section] = new List<ulong>();
                    continue;
                }
                if (!inBar || !t.StartsWith("-"))
                {
                    if (!t.StartsWith("-")) inBar = false;
                    continue;
                }
                var first = t.Substring(1).Trim().Split(',')[0].Trim();
                bars[section].Add(ulong.TryParse(first, NumberStyles.None, CultureInfo.InvariantCulture, out var id) ? id : 0);
            }
            return bars;
        }
    }
}

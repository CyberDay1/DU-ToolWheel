using System;
using System.Collections.Generic;
using System.Linq;

namespace ToolWheel
{
    /// The nanopack tools, as the item bank defines them (children of Tool, split into
    /// ExploreTool = roaming and BuildTool = build mode). The stock toolbar only holds what the
    /// player dragged onto it; the wheel lists every tool the player owns.
    public static class ToolCatalog
    {
        public sealed class Entry
        {
            public ulong Id;
            public string Name;      // item-bank name, e.g. "MiningTool"
            public string Label;     // item-bank display name, e.g. "Mine tool"
            public string Tooltip;   // item-bank tooltip, e.g. "Mine valuable ores"
            public string Group;     // "explore" or "build"
            public int ToolbarDefault;
            public int Slot = -1;    // nanopack slot (storage "0" position); -1 = not in the nanopack
        }

        /// The nanopack's storage id, as toolBar.changeItem takes it (argument 2).
        public const string NanopackStorageId = "0";

        /// What the client gets per tool. "slot" is the tool's nanopack position, the third
        /// argument of toolBar.changeItem(barIndex, "0", slot); null when unknown.
        public static Dictionary<string, object> ClientDto(Entry t) => new()
        {
            ["id"] = t.Id.ToString(),
            ["name"] = t.Name,
            ["label"] = t.Label,
            ["shortLabel"] = ShortLabel(t.Name, t.Label),
            ["tooltip"] = t.Tooltip,
            ["icon"] = IconFile(t.Name),
            ["slot"] = t.Slot >= 0 ? t.Slot : null,
        };

        /// Wheel order: the stock default bar order first (toolbarDefault 1..9), then the
        /// tools that have no default slot, in the order below (similar tools stay together).
        public static readonly string[] ExploreOrder =
        {
            "HarvestTool", "BlueprintTool", "RefuelTool", "MiningTool", "ScannerTool", "DetectorTool",
            "FlatteningTool", "PlanetSmoothTool", "DeployTool", "RepairTool", "ManeuverTool",
        };
        public static readonly string[] BuildOrder =
        {
            "ElementTool", "VoxelTool", "LineTool", "AreaSmoothTool", "SmoothTool", "LinkTool",
            "SelectTool", "ReplaceTool", "MoveTool", "VertexTool",
        };

        /// Icon file names in the client's loose icon library
        /// (Game/data/resources_generated/iconsLib/misclib/). Most are the lower-cased item name;
        /// these are the ones that are not.
        private static readonly Dictionary<string, string> IconExceptions = new(StringComparer.Ordinal)
        {
            ["HarvestTool"] = "harvestool",
            ["BlueprintTool"] = "blueprintstool",
            ["VertexTool"] = "vertex_precision_tool",
        };

        /// Short wedge labels (the item-bank display names are too long for a wedge, e.g.
        /// "Area smooth Voxel tool"). The full name and tooltip show in the hub.
        private static readonly Dictionary<string, string> ShortLabels = new(StringComparer.Ordinal)
        {
            ["HarvestTool"] = "Harvest", ["BlueprintTool"] = "Construct", ["RefuelTool"] = "Refuel",
            ["MiningTool"] = "Mining", ["ScannerTool"] = "Scanner", ["DetectorTool"] = "Detector",
            ["FlatteningTool"] = "Flatten", ["PlanetSmoothTool"] = "Smooth", ["DeployTool"] = "Element",
            ["RepairTool"] = "Repair", ["ManeuverTool"] = "Maneuver",
            ["ElementTool"] = "Element", ["VoxelTool"] = "Voxel", ["LineTool"] = "Line",
            ["AreaSmoothTool"] = "Area smooth", ["SmoothTool"] = "Smooth", ["LinkTool"] = "Link",
            ["SelectTool"] = "Select", ["ReplaceTool"] = "Replace", ["MoveTool"] = "Move",
            ["VertexTool"] = "Vertex",
        };

        /// Wedge label for a tool; unknown tools use their display label.
        public static string ShortLabel(string name, string label) =>
            name != null && ShortLabels.TryGetValue(name, out var s) ? s : label ?? name ?? "";

        public static string IconFile(string name) =>
            string.IsNullOrEmpty(name) ? "" :
            (IconExceptions.TryGetValue(name, out var f) ? f : name.ToLowerInvariant()) + ".png";

        /// Sorts and de-duplicates one group. A tool type held twice keeps its lowest known slot.
        public static List<Entry> Order(IEnumerable<Entry> tools, string group)
        {
            var order = group == "build" ? BuildOrder : ExploreOrder;
            return tools
                .Where(t => t.Group == group)
                .GroupBy(t => t.Id).Select(g => g.OrderBy(t => t.Slot < 0 ? int.MaxValue : t.Slot).First())
                .OrderBy(t => t.ToolbarDefault > 0 ? t.ToolbarDefault : 100)
                .ThenBy(t => { int i = Array.IndexOf(order, t.Name); return i < 0 ? 1000 : i; })
                .ThenBy(t => t.Name, StringComparer.Ordinal)
                .ToList();
        }
    }
}

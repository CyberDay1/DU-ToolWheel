using System.Linq;
using ToolWheel;
using Xunit;

public class ToolbarLayoutTests
{
    // Trimmed copy of a real player.toolbar value from a local myDU server (ver 1.01).
    private const string Sample =
        "ver: 1.01\n" +
        "build:\n" +
        "  bar:\n" +
        "    - 823239531,0,0,0\n" +
        "    - 2798413040,0,0,0\n" +
        "explore:\n" +
        "  bar:\n" +
        "    - 2687779164,0,0,0\n" +
        "    - 0,0,0,0\n" +
        "    - 1300972945,0,0,0\n" +
        "Fuel:\n" +
        "  bar:\n" +
        "    - 2579672037,0,0,0\n";

    [Fact]
    public void ParsesExploreAndBuildBarsInSlotOrder()
    {
        var bars = ToolbarLayout.Parse(Sample);
        Assert.Equal(new ulong[] { 823239531, 2798413040 }, bars["build"]);
        Assert.Equal(new ulong[] { 2687779164, 0, 1300972945 }, bars["explore"]);
        Assert.Equal(new ulong[] { 2579672037 }, bars["Fuel"]);
        Assert.False(bars.ContainsKey("ver"));
    }

    [Fact]
    public void HandlesCrLfAndCaseInsensitiveLookup()
    {
        var bars = ToolbarLayout.Parse(Sample.Replace("\n", "\r\n"));
        Assert.Equal(3, bars["EXPLORE"].Count);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("garbage")]
    public void EmptyOrUnknownGivesNoBars(string content) => Assert.Empty(ToolbarLayout.Parse(content));

    [Fact]
    public void BadSlotNumberIsEmptySlot()
    {
        var bars = ToolbarLayout.Parse("explore:\n  bar:\n    - abc,0,0,0\n    - 5,0,0,0\n");
        Assert.Equal(new ulong[] { 0, 5 }, bars["explore"]);
    }
}

public class ConfigTests
{
    [Fact]
    public void DefaultsAndSanitize()
    {
        var c = ToolWheelConfig.Parse("{ // comment\n \"hotkey\": \" \", \"loadSlot\": 12, \"defaultBar\": \"BUILD\", \"injectDelaysSeconds\": [-1], }");
        Assert.Equal("4", c.Hotkey);
        Assert.False(c.HoldAlt);
        Assert.Equal(9, c.LoadSlot);
        Assert.False(c.ShowAllTools);
        Assert.Equal("build", c.DefaultBar);
        Assert.Single(c.InjectDelaysSeconds);
        Assert.True(c.HideStockBar);
        Assert.False(c.HideToolsInInventory);
        Assert.Contains("\"hotkey\":\"4\"", c.ClientJson());
        Assert.Contains("\"hotkeyCode\":52", c.ClientJson());
        Assert.Contains("\"hideStockBar\":true", c.ClientJson());
        Assert.Contains("\"hideToolsInInventory\":false", c.ClientJson());
        Assert.Contains("\"holdAlt\":false", c.ClientJson());
        Assert.Contains("\"loadSlot\":8", c.ClientJson());
    }

    [Theory]
    [InlineData("4", 52)]
    [InlineData("g", 71)]
    [InlineData("192", 192)]
    [InlineData("220", 220)]
    [InlineData("\\", 220)]
    [InlineData("F5", 0)]
    [InlineData("", 0)]
    public void HotkeyCodes(string hotkey, int code) => Assert.Equal(code, ToolWheelConfig.HotkeyCode(hotkey));
}

public class QuickKeyTests
{
    private static readonly int[] Default =
        new ToolWheelConfig().QuickKeys.Select(ToolWheelConfig.QuickKeyCode).ToArray();

    [Fact]
    public void DefaultKeysAreOneToZeroThenMinusEquals()
    {
        Assert.Equal(new[] { 49, 50, 51, 52, 53, 54, 55, 56, 57, 48, 189, 187 }, Default);
    }

    [Theory]
    [InlineData(49, 11, 0)]   // 1 -> wedge 1
    [InlineData(52, 11, 3)]   // 4 -> wedge 4 (also the open hotkey)
    [InlineData(55, 11, 6)]   // 7
    [InlineData(48, 11, 9)]   // 0 -> wedge 10
    [InlineData(189, 11, 10)] // - -> wedge 11 (roaming has 11)
    [InlineData(173, 11, 10)] // - alternate code
    [InlineData(187, 12, 11)] // = -> wedge 12
    [InlineData(61, 12, 11)]  // = alternate code
    [InlineData(103, 11, 6)]  // numpad 7
    [InlineData(96, 10, 9)]   // numpad 0
    [InlineData(189, 10, -1)] // build has 10 tools: - selects nothing
    [InlineData(187, 11, -1)] // roaming has 11: = selects nothing
    [InlineData(65, 11, -1)]  // A is not a quick key
    [InlineData(0, 11, -1)]
    public void KeyToWedge(int keyCode, int tools, int wedge) =>
        Assert.Equal(wedge, ToolWheelConfig.QuickKeyIndex(Default, keyCode, tools));

    [Fact]
    public void CustomListKeepsPositionsAndSkipsBadEntries()
    {
        var c = ToolWheelConfig.Parse("{ \"quickKeys\": [\"q\", \"F5\", \" e \"] }");
        var codes = c.QuickKeys.Select(ToolWheelConfig.QuickKeyCode).ToArray();
        Assert.Equal(new[] { 81, 0, 69 }, codes);
        Assert.Equal(2, ToolWheelConfig.QuickKeyIndex(codes, 69, 11));
        Assert.Equal(-1, ToolWheelConfig.QuickKeyIndex(codes, 49, 11));
        Assert.Contains("\"quickKeys\":[{\"label\":\"q\",\"code\":81}", c.ClientJson());
    }

    [Fact]
    public void NullListFallsBackToDefaultAndEmptyListTurnsItOff()
    {
        Assert.Equal(12, ToolWheelConfig.Parse("{ \"quickKeys\": null }").QuickKeys.Count);
        Assert.Empty(ToolWheelConfig.Parse("{ \"quickKeys\": [] }").QuickKeys);
    }
}

public class ToolCatalogTests
{
    private static ToolCatalog.Entry T(string name, string group, int def, ulong id) =>
        new ToolCatalog.Entry { Id = id, Name = name, Label = name, Group = group, ToolbarDefault = def };

    [Fact]
    public void OrdersByDefaultSlotThenFixedOrderAndDedupes()
    {
        var tools = new[]
        {
            T("RepairTool", "explore", 0, 1), T("RefuelTool", "explore", 3, 2), T("HarvestTool", "explore", 1, 3),
            T("MiningTool", "explore", 0, 4), T("HarvestTool", "explore", 1, 3), T("VertexTool", "build", 0, 5),
            T("ElementTool", "build", 1, 6),
        };
        Assert.Equal(new[] { "HarvestTool", "RefuelTool", "MiningTool", "RepairTool" },
            ToolCatalog.Order(tools, "explore").Select(t => t.Name));
        Assert.Equal(new[] { "ElementTool", "VertexTool" }, ToolCatalog.Order(tools, "build").Select(t => t.Name));
    }

    [Fact]
    public void IconFilesMatchTheClientIconLibrary()
    {
        Assert.Equal("harvestool.png", ToolCatalog.IconFile("HarvestTool"));
        Assert.Equal("blueprintstool.png", ToolCatalog.IconFile("BlueprintTool"));
        Assert.Equal("vertex_precision_tool.png", ToolCatalog.IconFile("VertexTool"));
        Assert.Equal("miningtool.png", ToolCatalog.IconFile("MiningTool"));
    }

    [Fact]
    public void ShortLabelsFitAWedge()
    {
        Assert.Equal("Area smooth", ToolCatalog.ShortLabel("AreaSmoothTool", "Area smooth Voxel tool"));
        Assert.Equal("Construct", ToolCatalog.ShortLabel("BlueprintTool", "Deploy construct"));
        Assert.Equal("Odd tool", ToolCatalog.ShortLabel("OddTool", "Odd tool"));
    }

    [Fact]
    public void ClientDtoCarriesTheNanopackSlot()
    {
        var harvest = T("HarvestTool", "explore", 1, 2687779164);
        harvest.Slot = 14;
        var d = ToolCatalog.ClientDto(harvest);
        Assert.Equal(14, d["slot"]);
        Assert.Equal("2687779164", d["id"]);
        // A slot past the inventory grid (hidden tool) is sent as is: no special case.
        harvest.Slot = 300;
        Assert.Equal(300, ToolCatalog.ClientDto(harvest)["slot"]);
        Assert.Equal("{\"slot\":300}", System.Text.Json.JsonSerializer.Serialize(new { slot = ToolCatalog.ClientDto(harvest)["slot"] }));
    }

    [Fact]
    public void ClientDtoSendsNullForAnUnknownSlot()
    {
        var d = ToolCatalog.ClientDto(T("MiningTool", "explore", 4, 1));
        Assert.True(d.ContainsKey("slot"));
        Assert.Null(d["slot"]);
    }

    [Fact]
    public void NanopackStorageIdIsZero()
    {
        Assert.Equal("0", ToolCatalog.NanopackStorageId);
    }

    [Fact]
    public void DuplicateToolKeepsItsLowestKnownSlot()
    {
        var a = T("HarvestTool", "explore", 1, 7); a.Slot = 300;
        var b = T("HarvestTool", "explore", 1, 7); b.Slot = -1;
        var c = T("HarvestTool", "explore", 1, 7); c.Slot = 14;
        var only = Assert.Single(ToolCatalog.Order(new[] { a, b, c }, "explore"));
        Assert.Equal(14, only.Slot);
    }
}

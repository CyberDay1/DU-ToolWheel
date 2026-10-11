using System.Collections.Generic;
using System.Linq;
using ToolWheel;
using Xunit;
using Item = ToolWheel.NanopackHiding.Item;

public class NanopackHidingTests
{
    private static List<Item> Items(params (int slot, bool tool)[] xs) => xs.Select(x => new Item(x.slot, x.tool)).ToList();
    private static string Plan(List<NanopackHiding.Move> m) => string.Join(" ", m);

    [Fact]
    public void HidesVisibleToolsInSlotOrderFromTheBase()
    {
        var items = Items((0, true), (1, true), (2, false), (5, true));
        Assert.Equal("0->1000 1->1001 5->1002", Plan(NanopackHiding.PlanHide(items, 1000)));
    }

    [Fact]
    public void ToolsAlreadyAtOrAboveTheBaseStayAndAreNotOverwritten()
    {
        // 10-09 state: HarvestTool parked at 301 by the slot test, the rest still visible.
        var items = Items((0, true), (301, true), (1000, true), (1001, false), (3, true));
        var moves = NanopackHiding.PlanHide(items, 1000);
        Assert.Equal("0->1002 3->1003 301->1004", Plan(moves));
    }

    [Fact]
    public void NothingToHideWhenEveryToolIsHidden()
    {
        var items = Items((1000, true), (1001, true), (4, false));
        Assert.Empty(NanopackHiding.PlanHide(items, 1000));
    }

    [Fact]
    public void NonToolsAreNeverMoved()
    {
        var items = Items((0, false), (1, false), (300, false));
        Assert.Empty(NanopackHiding.PlanHide(items, 256));
        Assert.Empty(NanopackHiding.PlanUnhide(items, 256));
    }

    [Fact]
    public void HideTargetsAreDistinctAndFree()
    {
        var items = Enumerable.Range(0, 21).Select(i => new Item(i, true)).Append(new Item(1003, false)).ToList();
        var moves = NanopackHiding.PlanHide(items, 1000);
        Assert.Equal(21, moves.Count);
        Assert.Equal(21, moves.Select(m => m.To).Distinct().Count());
        Assert.DoesNotContain(moves, m => m.To == 1003);
        Assert.All(moves, m => Assert.True(m.To >= 1000));
    }

    [Fact]
    public void UnhideFillsTheFirstFreeVisibleSlots()
    {
        var items = Items((0, false), (2, false), (1000, true), (1001, true), (1002, true), (300, true));
        // 300 is hidden as well (past a 256 grid); lowest hidden slot first.
        Assert.Equal("300->1 1000->3 1001->4 1002->5", Plan(NanopackHiding.PlanUnhide(items, 256)));
    }

    [Fact]
    public void UnhideStopsWhenTheGridIsFull()
    {
        var items = Items((0, false), (1, false), (2, true), (1000, true), (1001, true));
        Assert.Equal("1000->3", Plan(NanopackHiding.PlanUnhide(items, 4)));
    }

    [Fact]
    public void UnhideThenHideRoundTrips()
    {
        var items = Items((1000, true), (1001, true), (7, false));
        var un = NanopackHiding.PlanUnhide(items, 256);
        var after = items.Select(i => { var m = un.FirstOrDefault(x => x.From == i.Slot); return un.Any(x => x.From == i.Slot) ? new Item(m.To, i.IsTool) : i; }).ToList();
        Assert.Equal("0->1000 1->1001", Plan(NanopackHiding.PlanHide(after, 1000)));
    }

    [Theory]
    [InlineData(1000, 256, 1000)]
    [InlineData(100, 256, 256)]   // a base inside the grid would hide nothing
    [InlineData(40000, 256, 32000)] // slot_number is a smallint
    [InlineData(1000, 0, 1000)]
    public void EffectiveBase(int configured, int grid, int expected) =>
        Assert.Equal(expected, NanopackHiding.EffectiveBase(configured, grid));
}

public class SingleSlotConfigTests
{
    [Fact]
    public void DefaultsKeepOneSlotAndHideTools()
    {
        var c = ToolWheelConfig.Parse("{}");
        Assert.True(c.SingleSlotBar);
        Assert.Equal(9, c.LoadSlot);
        Assert.True(c.HideToolsInNanopack);
        Assert.Equal(1000, c.HiddenSlotBase);
    }

    [Fact]
    public void ClientGetsTheZeroBasedSlotAndTheSingleSlotFlag()
    {
        var c = ToolWheelConfig.Parse("{ \"LoadSlot\": 3, \"SingleSlotBar\": false }");
        var json = c.ClientJson();
        Assert.Contains("\"loadSlot\":2", json);
        Assert.Contains("\"singleSlot\":false", json);
    }

    [Theory]
    [InlineData("{ \"HiddenSlotBase\": 0 }", 1000)]
    [InlineData("{ \"HiddenSlotBase\": 99999 }", 1000)]
    [InlineData("{ \"HiddenSlotBase\": 500 }", 500)]
    public void HiddenSlotBaseIsSanitized(string json, int expected) =>
        Assert.Equal(expected, ToolWheelConfig.Parse(json).HiddenSlotBase);
}

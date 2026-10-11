using System;
using System.Collections.Generic;
using System.Linq;

namespace ToolWheel
{
    /// Keeps the tools out of the inventory screen by parking them in nanopack slots the grid does
    /// not draw. The client grid shows slots 0 .. nanopackMaxSlots-1 (256 here). The server accepts
    /// any slot number (StorageWithSlotsV2.Move has no range check), and the client still holds a
    /// parked item, so toolBar.changeItem(bar, "0", slot) can load it (10-09 test: HarvestTool
    /// at 300 was hidden and still equipped).
    ///
    /// The hidden range starts at HiddenSlotBase (1000 by default). Nothing else lands there: the
    /// server puts new items in the LOWEST free slot (StorageWithSlotsV2.NewEmptySlot), so it would
    /// need 1000 occupied slots below the base first, and the client's grid cannot drop past 255.
    /// Pure planning only; MyDuMod performs the moves.
    public static class NanopackHiding
    {
        public readonly struct Item
        {
            public readonly int Slot;
            public readonly bool IsTool;
            public Item(int slot, bool isTool) { Slot = slot; IsTool = isTool; }
        }

        public readonly struct Move
        {
            public readonly int From, To;
            public Move(int from, int to) { From = from; To = to; }
            public override string ToString() => From + "->" + To;
        }

        /// Moves that put every tool below hiddenBase into the hidden range: the lowest tool goes
        /// to the first free slot at or above the base, and so on. Tools already at or above the
        /// base stay. Never targets an occupied slot.
        public static List<Move> PlanHide(IEnumerable<Item> items, int hiddenBase)
        {
            var all = items.ToList();
            var used = new HashSet<int>(all.Select(i => i.Slot));
            var moves = new List<Move>();
            int next = hiddenBase;
            foreach (var t in all.Where(i => i.IsTool && i.Slot < hiddenBase).OrderBy(i => i.Slot))
            {
                while (used.Contains(next)) next++;
                moves.Add(new Move(t.Slot, next));
                used.Add(next);
                used.Remove(t.Slot);
                next++;
            }
            return moves;
        }

        /// Moves that bring every tool at or above gridSize (hidden) back into the first free
        /// visible slots (0 .. gridSize-1), lowest hidden slot first. Tools that do not fit stay
        /// hidden (the caller reports them).
        public static List<Move> PlanUnhide(IEnumerable<Item> items, int gridSize)
        {
            var all = items.ToList();
            var used = new HashSet<int>(all.Select(i => i.Slot));
            var moves = new List<Move>();
            int next = 0;
            foreach (var t in all.Where(i => i.IsTool && i.Slot >= gridSize).OrderBy(i => i.Slot))
            {
                while (next < gridSize && used.Contains(next)) next++;
                if (next >= gridSize) break;
                moves.Add(new Move(t.Slot, next));
                used.Add(next);
                next++;
            }
            return moves;
        }

        /// The hidden base actually used: at least the grid size (a base inside the grid would hide
        /// nothing) and at most 32000 (player_inventory.slot_number is a smallint).
        public static int EffectiveBase(int configured, int gridSize) =>
            Math.Min(32000, Math.Max(configured, Math.Max(1, gridSize)));
    }
}

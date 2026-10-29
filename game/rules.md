# War Games - Rules

These are the rules as `server/engine.ts` enforces them. The faction AIs never read
this file: each one gets its persona (`game/factions/*.md`) and a JSON briefing every
turn. If you rebalance the engine, update this file to match.

## Overview

Turn-based geopolitical strategy game. Three great powers (NATO, Russia, China) compete
on a 25-territory world map for territory, gold, or alliances. Games last at most 20 turns.

## Factions

Starting positions are deliberately asymmetric (they follow the real-world balance of power):

| ID | Name | Territories | Units | Tech (mil/eco/int/nuc) | Warheads |
|----|------|-------------|-------|------------------------|----------|
| nato | NATO / United States | 8 | 8 | 2 / 2 / 2 / 1 | 2 |
| russia | Russian Federation | 3 | 6 | 2 / 0 / 2 / 1 | 2 |
| china | People's Republic of China | 2 | 8 | 1 / 2 / 1 / 1 | 1 |

Everyone starts level on nuclear (tech 1; NATO and Russia hold 2 warheads, China 1), so nobody can retaliate until someone researches Second Strike.

### Mirror scenario

`SCENARIO=mirror` (`game/scenarios/mirror.json`) starts every faction level: 3 territories (NATO: western_na, eastern_na, alaska; Russia: western_russia, central_asia, ukraine; China: southeast_asia, india, pakistan), all plains with the same three yields (4 gold 3 food 2 knowledge / 3 iron 2 food 2 uranium / 2 gold 2 iron 1 influence); 6 units (4 infantry, 1 armor, 1 artillery); 18 gold / 14 food / 12 iron / 9 influence / 7 knowledge / 6 uranium; tech 2/1/1/1; 2 warheads; **no continent bonuses**; every other territory neutral with mercenaries. Identical play from this start ends in a draw. What still differs is the neighbourhood (which neutral land, and how much coast, is next door), so a tournament still rotates models through the seats. The personas get an override note retracting their default starting claims.

The other 12 territories start neutral and are held by mercenaries (1-4 each).

## Map

- 25 territories on 6 continents. Adjacency is in `game/initial-world.json`.
- Terrain: 10 coast, 9 plains, 6 mountains. Mountains give the defender +2. Coast counts
  toward the economic victory and, with Trade Networks, pays +1 gold.
- Each territory yields its own mix of resources every turn to its owner.

### Continent bonuses (paid every turn you hold the whole continent)

| Continent | Bonus | Territories |
|-----------|-------|-------------|
| North America | +4 gold, +2 food | alaska, western_na, eastern_na, central_america |
| South America | +2 iron, +2 food | amazonia, andes, colombia_venezuela |
| Europe | +4 knowledge, +2 influence | scandinavia, western_europe, eastern_europe, ukraine, western_russia, mediterranean |
| Africa & Middle East | +3 gold, +2 influence, +1 uranium | middle_east, north_africa, central_africa, south_africa |
| Asia | +3 gold, +3 iron, +2 food | siberia, central_asia, iran, east_asia, india, pakistan |
| Oceania & Pacific | +2 gold, +1 uranium | southeast_asia, australia |

## Resources

Gold, food, iron, influence, knowledge, uranium.

Every turn, in this order, each faction:

1. Gains +1 knowledge, its territories' yields, and any continent bonuses.
2. With economic 1, gains +1 gold per coast territory. With economic 2, gains 10% interest on gold (rounded down).
3. Pays 1 food per unit. Food never goes below 0. Each unit that can't be fed (newest
   units first) loses 1 hp, and units at 0 hp are lost to starvation.

## Units

| Unit | Attack | Defense | Movement | Cost | Requires |
|------|--------|---------|----------|------|----------|
| infantry | 2 | 2 | 1 | 2 gold + 1 iron | - |
| armor | 3 | 1 | 2 | 4 gold + 2 iron | military 1 |
| artillery | 4 | 1 | 1 | 5 gold + 3 iron | military 2 |

- Units have 2 hp. They gain 1 xp from every fight they survive, and each xp adds +1 to attack and defense.
- Each unit can make **one** move or attack per turn. Units that are recruited or hired can't act until next turn.
- New unit ids continue the faction's numbering (`nato-inf-8`, `russia-merc-1`, ...) and are never reused.

## Turn structure

Each turn, every faction submits up to **3** orders as JSON (extra orders are dropped), plus an optional private `notes` memo of up to 300 characters.
All factions are briefed at once and order at the same time. Their orders are then resolved
faction by faction, and **the faction that resolves first rotates every turn**
(NATO first on turn 1, Russia on turn 2, China on turn 3, ...).

Orders must name exact unit and territory ids. An order that names an unknown unit, a unit
that has already acted, or a destination it can't reach is rejected. The engine never
substitutes another unit for you.

### Orders

| Action | Fields | Effect |
|--------|--------|--------|
| `move` | `unit`, `to` | Move to a territory in range: one that's adjacent or, for armor, two steps away through a territory you own with no foreign units. Entering neutral or undefended land captures it, and neutral land with mercenaries means a fight. Moving into enemy units is an attack, so the target must be adjacent. |
| `attack` | `unit`, `target` | Attack an adjacent territory you don't own. If it's empty you take it. |
| `fortify` | `territory` | 2 iron. +2 defense on a territory you own until it's captured. |
| `recruit` | `type`, `territory` | Raise a unit in a territory **you own**. |
| `research` | `tech` | Raise one track a level (see Tech). |
| `trade` | `to`, `offer` | Give resources to another faction. The full offer must be affordable or nothing moves. The recipient is told. |
| `spy` | `target` | 2 influence (1 with intelligence 1). The target shows up in your **next** turn's briefing. |
| `diplomacy` | `to`, `proposal: "alliance"` | Propose an alliance (see Diplomacy). Any other proposal text is only delivered to the target as a message. |
| `break_alliance` | `to` | End an alliance. You become an Oathbreaker for good and gain +3 attack for the rest of the turn. |
| `message` | `message`, optional `to` | Up to 280 characters. With `to` only that faction receives it; otherwise both others do. |
| `hire_mercenary` | `territory` | 5 gold. Take one mercenary from a territory that has mercenaries and that you border or stand in, as your own infantry. A neutral territory becomes yours. |
| `build_nuke` | - | Needs nuclear 1. Costs 10 gold + 5 uranium (8 + 3 from nuclear 2). |
| `nuke` | `target` | Spends one warhead you hold (see Nuclear exchange). |

## Combat

`roll = d6 + attack - defense`

- **Attack** = unit attack + xp + 1 at military 3 + 3 for a betrayal surprise this turn.
- **Defense** = unit defense + xp + terrain (mountains +2) + fortification +2 (artillery at
  military 2 ignores this) + 1 at military 3 + 1 more for a defender with xp at military 3.
- Only the first defending unit in a territory fights.

| Roll | Result |
|------|--------|
| 7+ | The defender takes 2 damage. If it survives, it retreats to an adjacent territory its owner holds, or else it's destroyed. The attacker moves in, takes the territory and clears its fortification. The attacker gains 1 xp. |
| 4-6 | Draw: both take 1 damage, survivors gain 1 xp, and nothing moves. |
| 3 or less | The attacker takes 2 damage and the defender gains 1 xp. |

**Mercenaries** defend as infantry plus terrain. On 5+ they're all cleared and the attacker takes the territory. On 3-4 one mercenary is removed and the attacker takes 1 damage. Anything lower and the attacker takes 1 damage.

## Diplomacy

- An alliance forms when both factions propose it. The target sees your proposal in its next
  briefing (`incomingAllianceProposals`, plus a note in its `inbox`). A proposal lapses if it isn't answered within 2 turns.
- Allies share vision of each other's territories.
- Allies can't attack, move into, or nuke each other's territory. They have to `break_alliance` first.
- An Oathbreaker can never form another alliance, and nobody can ally with one.
- Messages, trades and proposals from other factions arrive in your briefing's `inbox` (the last 10 are shown).

## Notes

A faction can add `"notes": "..."` (up to 300 characters) to its reply. It comes back in that
faction's next briefing as `yourNotes`, and is kept until the faction sends new notes. Notes are
private: no other faction and not the narrator ever sees them, but the War Room view shows them.

## Dice

Every die roll comes from a seeded generator. Set `SEED` and the same orders give the same
battles; otherwise each game draws a new seed. The seed is announced when the game starts and
shown in the end-of-game summary.

## Fog of war

You see your territories, territories adjacent to them or to your units, your allies'
territories, and whatever you spied on last turn. Combat, captures, nukes, betrayals and
warhead builds and victories are announced to everyone in `recentEvents` (the last 3 turns). Your own events, and trades sent to you, are shown to you as well.

## Tech

Research costs knowledge only (nuclear also costs uranium). Every track has 3 levels.

| Level | Military / economic / intelligence cost | Nuclear cost |
|-------|----------------------------------------|--------------|
| 1 | 3 knowledge | 5 knowledge + 3 uranium |
| 2 | 5 knowledge | 8 knowledge + 5 uranium |
| 3 | 8 knowledge | 10 knowledge + 8 uranium |

Effects the engine implements:

- **Military**: 1 unlocks armor, 2 unlocks artillery (ignores fortifications), 3 gives +1 attack and defense to all units, +1 defense to veterans.
- **Economic**: 1 gives +1 gold per coast territory, 2 gives 10% interest on gold. Level 3 has no effect yet.
- **Intelligence**: 1 makes spying cost 1 influence. Levels 2 and 3 have no effect yet.
- **Nuclear**: 1 enables `build_nuke` (adjacent strikes only), 2 gives cheaper warheads and global range, 3 gives second strike and deterrence.

`game/tech-tree.json` also describes effects that aren't implemented: sanctions, sabotage,
false flag, revealing enemy orders, the 20% trade bonus, the recruitment discount, +1 armor
movement, and research costs in resources other than knowledge and uranium.

## Nuclear exchange

- Below nuclear 2 the target has to be adjacent to a territory you own. From nuclear 2 any territory is in range. You can't nuke your own or an ally's territory.
- A strike destroys every unit there, whoever owns them. The territory loses its fortification
  and becomes neutral, and its yield is wiped for the next 5 turns (**fallout**). After that the
  yield returns to whoever holds the land; land captured during fallout pays nothing until then,
  and a second strike restarts the clock. Briefings show `falloutClearsOnTurn`.
- **Second strike**: if the target belonged to a faction with nuclear 3 and at least one warhead,
  that faction automatically fires one back at a random territory you own. A retaliation
  doesn't trigger another retaliation.
- **Deterrence**: at nuclear 3, every warhead you build costs each other faction 5 influence.

## Victory

Checked at the end of every turn. If more than one faction qualifies at once, the higher score wins. An exact score tie is a **draw** (no victor), so faction order never decides a game.

1. **Domination**: hold 16+ territories.
2. **Economic**: hold 100+ gold and 8+ coast territories.
3. **Diplomatic**: be allied with both other factions, with each alliance held for 10+ turns.

If nobody has won by turn 20, the highest score wins (an exact tie is a draw):

`score = territories × 3 + floor(all six resources / 5) + (sum of all four tech levels) × 2`

## Order format

The `notes` field is optional.

```json
{
  "orders": [
    {"action": "move", "unit": "nato-inf-1", "to": "central_america"},
    {"action": "recruit", "type": "infantry", "territory": "western_na"},
    {"action": "diplomacy", "to": "china", "proposal": "alliance"}
  ],
  "reasoning": "Expanding south while courting Beijing",
  "notes": "Ukraine by turn 4; keep China sweet until Siberia is fortified"
}
```

A reply that isn't valid JSON, or has no `orders` array, forfeits the turn.

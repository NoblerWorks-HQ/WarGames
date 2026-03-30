# War Games - Rules

## Overview

Turn-based military/geopolitical strategy game. 3 great powers (NATO, Russia, China) compete on a globe map with 20 territories (Risk-style) for territorial control, resource dominance, or diplomatic victory.

## Factions

| ID | Name | Starting Region | Playstyle |
|----|------|-----------------|-----------|
| nato | NATO Coalition | Transatlantic (NA + W. Europe) | Tech advantage, coalition warfare, democratic constraints |
| russia | Russian Federation | Eurasia (Siberia, E. Europe, C. Asia) | Defensive depth, nuclear deterrence, hybrid warfare |
| china | People's Republic of China | Indo-Pacific (E. Asia, S. Asia, Indonesia) | Economic leverage, long-term strategy, regional influence |

## Map

- 20 territories across 6 continents on a globe
- Continents: North America (4), South America (3), Europe (4), Africa (3), Asia (4), Oceania (2)
- Controlling an entire continent grants bonus resources each turn
- 3 terrain types:
  - **Plains**: +Food per turn, normal movement
  - **Mountains**: +Iron per turn, +2 defense bonus
  - **Coast**: +Gold per turn via trade ports

## Resources

| Resource | Source | Used For |
|----------|--------|----------|
| Gold | Coast territories, trade | Recruitment, trade deals |
| Food | Plains territories | Troop maintenance (1 Food per unit per turn) |
| Iron | Mountain territories | Recruitment, fortifications |
| Influence | Earned via diplomacy actions | Espionage, alliances |
| Knowledge | 1 per turn base + territory bonuses | Tech tree research |

## Continent Bonuses

| Continent | Bonus | Territories |
|-----------|-------|-------------|
| North America | +2 Food | alaska, western_na, eastern_na, central_america |
| South America | +2 Iron | amazonia, andes, patagonia |
| Europe | +2 Knowledge | scandinavia, western_europe, eastern_europe, mediterranean |
| Africa | +2 Influence | north_africa, central_africa, south_africa |
| Asia | +3 Gold | siberia, central_asia, east_asia, south_asia |
| Oceania | +1 Gold | indonesia, australia |

## Units

Each faction starts with 3 Infantry units.

| Unit | Attack | Defense | Movement | Cost |
|------|--------|---------|----------|------|
| Infantry | 2 | 2 | 1 territory/turn | 2 Gold + 1 Iron |
| Cavalry | 3 | 1 | 2 territory/turn | 3 Gold + 1 Iron |
| Siege | 4 | 1 | 1 territory/turn | 4 Gold + 2 Iron |

Units unlocked via tech tree (start with Infantry only).

## Turn Structure

Each turn, factions submit up to 3 orders (JSON format only).

### Order Types

1. **move** - Move a unit to an adjacent territory
   ```json
   {"action":"move","unit":"nato-inf-1","to":"central_america"}
   ```

2. **attack** - Attack enemy units in an adjacent territory
   ```json
   {"action":"attack","unit":"nato-inf-1","target":"scandinavia"}
   ```

3. **fortify** - Build defenses in a held territory (+2 defense)
   ```json
   {"action":"fortify","territory":"alaska"}
   ```

4. **recruit** - Raise a new unit in an owned territory
   ```json
   {"action":"recruit","type":"infantry","territory":"western_na"}
   ```

5. **trade** - Send resources to another faction
   ```json
   {"action":"trade","to":"russia","offer":{"gold":5}}
   ```

6. **spy** - Reveal fog of war on a target territory
   ```json
   {"action":"spy","target":"south_asia"}
   ```

7. **research** - Progress on tech tree
   ```json
   {"action":"research","tech":"military"}
   ```

8. **diplomacy** - Propose alliance
   ```json
   {"action":"diplomacy","to":"china","proposal":"alliance"}
   ```

## Combat Resolution

When a unit moves into or attacks an enemy territory:
1. Attacker strength = unit attack + tech bonuses
2. Defender strength = unit defense + terrain bonus + fortification bonus
3. Roll = random(1-6) + strength difference
4. Roll >= 7: Attacker wins, defender retreats or is destroyed
5. Roll 4-6: Draw, both units take 1 damage
6. Roll <= 3: Defender wins, attacker retreats

Terrain bonuses:
- Mountains: +2 defense
- Fortified territory: +2 defense
- Coast/Plains: no bonus

## Fog of War

- Each faction sees territories they control + adjacent territories
- Spy action reveals a target territory for 1 turn
- Alliance partners share vision

## Victory Conditions (first to achieve any)

1. **Domination**: Control 10+ territories (50% of globe)
2. **Economic**: Accumulate 30 Gold while holding 3+ Coast territories
3. **Diplomatic**: Form alliance with both other factions simultaneously for 5 turns

## Game Length

- Maximum 20 turns - games are fast and aggressive
- If no victory by turn 20, highest score wins
- Score = (territories * 3) + (total resources / 5) + (tech levels * 2)

## Faction Order Format

CRITICAL: Factions must respond ONLY in valid JSON. Non-JSON responses are treated as a forfeit.

```json
{
  "orders": [
    {"action": "move", "unit": "nato-inf-1", "to": "central_america"},
    {"action": "recruit", "type": "infantry", "territory": "alaska"},
    {"action": "research", "tech": "military"}
  ],
  "reasoning": "Expanding south while building forces"
}
```

Maximum 3 orders per turn. Use territory IDs (snake_case). The `reasoning` field is optional, max 1 sentence.

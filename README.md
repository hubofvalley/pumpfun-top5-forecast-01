# Snapshot forecast

A deterministic, offline forecast of five pump.fun market-cap ranks and their size bins. It combines recent observed caps and bounded momentum with seeded simulations of future prices and anonymous new entrants. It averages across the answer-read horizons.

Run with Node 22: `node main.ts`. Input defaults to `/input` and output to `/output`; `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` override them. Input must contain `task.json` and `history.ndjson` with at least five distinct ranked coins.

This is a heuristic, not a calibrated model. It cannot identify future launches, assumes independent price shocks, and cannot account for news, changing liquidity or recorder omissions. No future score or profit is guaranteed.

# T030 MAGMA reproduction gate faithfulness investigation

Date: 2026-07-07

## Scope and guard status

- Repository: `$HOME/Coding_Projects/scns_root/scns` on `feature/fable-5-implementation`.
- Snapshot reopened, not re-ingested: `.copilot-scratch/t030-20260706-203640/frontier/snap`. Manifest rows: conv-48 materialized=32 persisted=16; conv-49 materialized=84 persisted=42; conv-50 materialized=100 persisted=50.
- Deterministic/no-generation modes only. Token mode reported: `spawn guard: 0 ephemeral ACP process(es) spawned; still-alive 0; strays killed-by-pid 0; exit-signalled 0`; `ISO cleaned (zero-pollution): YES`; `live vault mtime unchanged: YES`.
- Live-vault guard before/after: `mtime=1783256409 size=232488960` before; after investigation stat is `mtime=1783256409 size=232488960`.
- Note: the requested contract path `specs/002-north-star-audit-remediation/contracts/reproduction-health-gate.contract.md` is not present in this checkout; the rule text was taken from the task prompt and the current harness evidence rows.

## Per-arm deterministic token means

Command mode: `SCNS_JUDGE_MODE=arm-frontier-tokens` with `SCNS_FRONTIER_SNAPSHOT=$PWD/.copilot-scratch/t030-20260706-203640/frontier/snap`, `RETRIEVAL_TOPK=5`, `RETRIEVAL_MAX_CHARS=4000`.

Real harness output row:

```text
bound 90 probe items across 3 conv(s) (cat1=18 cat2=18 cat3=18 cat4=18 cat5=18)
PRE-CHECK causal materialized=216 persisted=108 ⇒ beam has causal chains on ≥1 conv
hybrid       mean 147 tok  (Δ vs incumbent +0)
magma        mean 272 tok  (Δ vs incumbent +126)
multihop-iter mean 147 tok  (Δ vs incumbent +0)
RESULTS_JSON: {"mode":"arm-frontier-tokens","preCheck":{"materialized":216,"persisted":108},"nItems":90,"byCategory":"cat1=18 cat2=18 cat3=18 cat4=18 cat5=18","arms":[{"name":"hybrid","meanTokO200k":147,"deltaVsIncumbent":0},{"name":"magma","meanTokO200k":272,"deltaVsIncumbent":126},{"name":"multihop-iter","meanTokO200k":147,"deltaVsIncumbent":0}],"incumbent":"hybrid"}
```

Interpretation: magma is +126 tokens over hybrid, but the item probes below show that the increase is Stage-4 provenance/timestamp serialization, not additional retrieved chunk IDs. `multihop-iter` is exactly hybrid-sized on this token axis.

## Probe method

I added a clearly named throwaway probe at `.copilot-scratch/t030-faithfulness-probe.ts`. It reopens the snapshot DBs with `reopenVaultSnapshot`, rebuilds the oracle gazetteer with `oracleGazetteer`, then calls production `retrieveContext` with the harness arm configs:

- hybrid: `{ intentRouting:false, topK:5, maxChars:4000 }`
- magma: `{ intentRouting:false, traverse:true, traversalOptions:{maxDepth:5,budget:200}, synthesize:true, topK:5, maxChars:4000 }`

The probe also mirrors the `adaptiveTraversalSearch` loop for debug counters only, recording anchor count, visited count, traversed count, and which edge type admitted each newly reached beam node. Raw JSON: `.copilot-scratch/t030-faithfulness-probe-results.json`.

## Item-level context diffs

### Item 1: conv-48 cat4

- Question: What pets does Jolene have?
- Gold: snakes
- Evidence dia/chunks: ['D2:20', 'D2:22', 'D2:24'] / [248, 250, 252]
- Hybrid: tokens=100, chunkIds=[253, 119, 334, 323, 329], goldExactPresent=False, evidenceChunksPresent=[]
- Magma: tokens=224, chunkIds=[253, 119, 334, 323, 329], goldExactPresent=False, evidenceChunksPresent=[]
- Context differs: True. Retrieval-set differs: False.
- Anchor retention: hybridTop=253, hybridTopRetained=True, hybridTop5Retained=5/5; baseAnchorTop20=[253, 119, 334, 323, 329, 751, 179, 807, 239, 462, 139, 691, 62, 132, 254, 742, 107, 320, 755, 325]; magmaTopVisited=[253, 119, 334, 323, 329].
- Traversal debug: intent=ENTITY, anchorCount=20, visitedCount=60, traversedCount=40, reachedByDepth=[8, 8, 8, 8, 8], reachedByType={'entity': 40, 'semantic': 0, 'temporal': 0, 'causal': 0}, traversedAbsentFromHybridCount=40.
- Sample traversed nodes absent from hybrid top-5: [{'id': 287, 'excerpt': 'Jolene: Mostly happy or a bit of everything?'}, {'id': 331, 'excerpt': 'Jolene: How old is Luna?'}]

Hybrid context (unelided):

```text
Relevant SCNS memories:
Deborah: Cool, Jolene! Pets bring so much happiness!

Jolene: I got her last year, she's a great pet. She always cheers me up and brings a sense of peace. Spending time with her is so comforting.

Jolene: I am proud of your action to tame these pets!

Jolene: Aww, that's adorable! What's the second one's name?

Jolene: It’s wonderful that you have become their loving owner!
```

Magma context (unelided):

```text
Relevant SCNS memories:
[<t:2023-01-27T09:49:00.000Z> Deborah: Cool, Jolene! Pets bring so much happiness! <ref:253>]
[<t:2023-06-26T09:17:00.000Z> Jolene: I got her last year, she's a great pet. She always cheers me up and brings a sense of peace. Spending time with her is so comforting. <ref:119>]
[<t:2023-08-26T17:33:00.000Z> Jolene: I am proud of your action to tame these pets! <ref:334>]
[<t:2023-08-26T17:33:00.000Z> Jolene: Aww, that's adorable! What's the second one's name? <ref:323>]
[<t:2023-08-26T17:33:00.000Z> Jolene: It’s wonderful that you have become their loving owner! <ref:329>]
```

### Item 2: conv-49 cat4

- Question: What type of car did Evan get after his old Prius broke down?
- Gold: new Prius
- Evidence dia/chunks: ['D1:2'] / [12]
- Hybrid: tokens=210, chunkIds=[510, 588, 17, 604, 176], goldExactPresent=True, evidenceChunksPresent=[]
- Magma: tokens=334, chunkIds=[510, 588, 17, 604, 176], goldExactPresent=True, evidenceChunksPresent=[]
- Context differs: True. Retrieval-set differs: False.
- Anchor retention: hybridTop=510, hybridTopRetained=True, hybridTop5Retained=5/5; baseAnchorTop20=[510, 588, 17, 604, 176, 184, 12, 511, 474, 581, 183, 594, 16, 582, 126, 508, 546, 125, 476, 273]; magmaTopVisited=[510, 588, 17, 604, 176].
- Traversal debug: intent=WHEN, anchorCount=20, visitedCount=60, traversedCount=40, reachedByDepth=[8, 8, 8, 8, 8], reachedByType={'entity': 0, 'semantic': 0, 'temporal': 40, 'causal': 0}, traversedAbsentFromHybridCount=40.
- Sample traversed nodes absent from hybrid top-5: [{'id': 127, 'excerpt': "Evan: It's been a bit of a rough patch lately. The company downsized, and I was part of that. I'm currently on the hunt for a new job, which hasn't been easy, but I'm keeping my spirits up and staying hopeful."}, {'id': 233, 'excerpt': "Evan: It's not easy for us right now, my son had an accident last Tuesday, he fell off his bike and it was rough. But he's doing better now. How are you dealing with all this? [shared image: a photo of a young boy with crutches and a backpack]"}]

Hybrid context (unelided):

```text
Relevant SCNS memories:
Evan's old Prius broke down, so he decided to get it repaired and sell it, and he bought a new Prius.

Evan's new Prius, which he had recently bought, broke down, leaving him without his main mode of transport for his active lifestyle and road trips.

Evan: My old prius broke down, decided to get it repaired and sell it. Glad you asked, we went to Rockies, check it out.
[shared image: a photo of a lake with rocks and mountains in the background]

Evan took his Prius for a long drive to the mountains last weekend and got into a minor car accident on the way back, but he and his companions were unharmed.

Evan: Hey Sam, good to hear from you. I've hit a bit of a snag - my new Prius, the one I just bought, broke down. It's a bit of a stressor since I rely on it for my active lifestyle and road trips. It's frustrating when new things go awry so soon.
```

Magma context (unelided):

```text
Relevant SCNS memories:
[<t:2023-05-18T13:47:00.000Z> Evan's old Prius broke down, so he decided to get it repaired and sell it, and he bought a new Prius. <ref:510>]
[<t:2023-05-18T13:47:00.000Z> Evan: My old prius broke down, decided to get it repaired and sell it. Glad you asked, we went to Rockies, check it out.
[shared image: a photo of a lake with rocks and mountains in the background] <ref:17>]
[<t:2023-12-05T20:16:00.000Z> Evan's new Prius, which he had recently bought, broke down, leaving him without his main mode of transport for his active lifestyle and road trips. <ref:588>]
[<t:2023-12-05T20:16:00.000Z> Evan: Hey Sam, good to hear from you. I've hit a bit of a snag - my new Prius, the one I just bought, broke down. It's a bit of a stressor since I rely on it for my active lifestyle and road trips. It's frustrating when new things go awry so soon. <ref:176>]
[<t:2023-12-31T11:00:00.000Z> Evan took his Prius for a long drive to the mountains last weekend and got into a minor car accident on the way back, but he and his companions were unharmed. <ref:604>]
```

### Item 3: conv-50 cat4

- Question: How long did Calvin plan to stay in Japan?
- Gold: A few months
- Evidence dia/chunks: ['D1:15'] / [7]
- Hybrid: tokens=137, chunkIds=[647, 7, 572, 623, 571], goldExactPresent=True, evidenceChunksPresent=[7]
- Magma: tokens=262, chunkIds=[647, 7, 572, 623, 571], goldExactPresent=True, evidenceChunksPresent=[7]
- Context differs: True. Retrieval-set differs: False.
- Anchor retention: hybridTop=647, hybridTopRetained=True, hybridTop5Retained=5/5; baseAnchorTop20=[647, 7, 572, 623, 571, 590, 605, 16, 661, 21, 19, 213, 97, 609, 412, 621, 45, 15, 277, 595]; magmaTopVisited=[647, 7, 572, 623, 571].
- Traversal debug: intent=ENTITY, anchorCount=20, visitedCount=60, traversedCount=40, reachedByDepth=[8, 8, 8, 8, 8], reachedByType={'entity': 40, 'semantic': 0, 'temporal': 0, 'causal': 0}, traversedAbsentFromHybridCount=40.
- Sample traversed nodes absent from hybrid top-5: [{'id': 23, 'excerpt': "Calvin: Japan definitely has it all - vibes, food, tech, and an amazing culture. It's like stepping into another world. I've been working on some cool music collaborations with Japanese artists, and I'm really excited to hear how it turns out!"}, {'id': 273, 'excerpt': 'Calvin: Yes, Dave! That was an incredible experience to visit similar streets like you shared in your photo. Is there anything else that interests you in Tokyo?'}]

Hybrid context (unelided):

```text
Relevant SCNS memories:
Calvin took a trip to Japan that he found incredible for its culture and people, and he already longs to return.

Calvin: I'm gonna be in Japan for a few months then off to Boston! I can't wait!

Calvin's agent found him a nice place to stay in Japan for his upcoming trip, which Calvin was thankful for.

After finishing his music tour in Japan, Calvin explored his new place, which he described as a dream come true.

Calvin decided to travel to Japan next month to learn about Japanese culture, planning to explore the city, try local cuisines, and collaborate with local musicians, before heading to Boston after a few months.
```

Magma context (unelided):

```text
Relevant SCNS memories:
[<t:2023-09-22T20:57:00.000Z> Calvin took a trip to Japan that he found incredible for its culture and people, and he already longs to return. <ref:647>]
[<t:2023-03-23T11:53:00.000Z> Calvin: I'm gonna be in Japan for a few months then off to Boston! I can't wait! <ref:7>]
[<t:2023-03-23T11:53:00.000Z> Calvin's agent found him a nice place to stay in Japan for his upcoming trip, which Calvin was thankful for. <ref:572>]
[<t:2023-08-14T00:35:00.000Z> After finishing his music tour in Japan, Calvin explored his new place, which he described as a dream come true. <ref:623>]
[<t:2023-03-23T11:53:00.000Z> Calvin decided to travel to Japan next month to learn about Japanese culture, planning to explore the city, try local cuisines, and collaborate with local musicians, before heading to Boston after a few months. <ref:571>]
```

### Item 4: conv-48 cat1

- Question: Which of Deborah`s family and friends have passed away?
- Gold: mother, father, her friend Karlie
- Evidence dia/chunks: ['D1:5', 'D2:1', 'D6:4'] / [14, 236, 610]
- Hybrid: tokens=238, chunkIds=[687, 442, 236, 14, 706], goldExactPresent=False, evidenceChunksPresent=[14, 236]
- Magma: tokens=362, chunkIds=[687, 442, 236, 14, 706], goldExactPresent=False, evidenceChunksPresent=[14, 236]
- Context differs: True. Retrieval-set differs: False.
- Anchor retention: hybridTop=687, hybridTopRetained=True, hybridTop5Retained=5/5; baseAnchorTop20=[687, 442, 236, 14, 706, 247, 708, 611, 707, 15, 688, 683, 614, 684, 662, 610, 326, 803, 332, 787]; magmaTopVisited=[687, 442, 236, 14, 706].
- Traversal debug: intent=ENTITY, anchorCount=20, visitedCount=60, traversedCount=40, reachedByDepth=[8, 8, 8, 8, 8], reachedByType={'entity': 40, 'semantic': 0, 'temporal': 0, 'causal': 0}, traversedAbsentFromHybridCount=40.
- Sample traversed nodes absent from hybrid top-5: [{'id': 612, 'excerpt': "Deborah: Thanks for the kind words. It's been tough, but I'm comforted by remembering our time together. It reminds me of how special life is."}, {'id': 225, 'excerpt': "Deborah: I'll always cherish my memories with her at this spot. I remember a beautiful sunset we watched together in silence - the colors in the sky were so special. Every time I go back, I feel so much peace and gratitude for the time I spent with her."}]

Hybrid context (unelided):

```text
Relevant SCNS memories:
Deborah's father passed away suddenly two days ago, and Deborah is coping with the grief by spending more time with her family and cherishing their shared memories.

Deborah: Since speaking last, I reconnected with my mom's old friends. Their stories made me tear up and reminded me how lucky I am to have had her.
[shared image: a photo of a living room with a couch and a fire place]

Deborah: Hey Jolene, sorry to tell you this but my dad passed away two days ago. It's been really tough on us all - his sudden death left us all kinda shell-shocked. I'm trying to channel my grief by spending more time with family and cherishing the memories. These moments remind me to live life fully.
[shared image: a photo of a woman hugging a woman who is sitting on a couch]

Deborah: It was full of memories, she passed away a few years ago. This is our last photo together.
[shared image: a photo of a woman in a wheelchair hugging a woman in a wheelchair]

Deborah lost her friend Karlie the week before this session and has been grieving the loss.
```

Magma context (unelided):

```text
Relevant SCNS memories:
[<t:2023-01-27T09:49:00.000Z> Deborah's father passed away suddenly two days ago, and Deborah is coping with the grief by spending more time with her family and cherishing their shared memories. <ref:687>]
[<t:2023-09-15T15:09:00.000Z> Deborah: Since speaking last, I reconnected with my mom's old friends. Their stories made me tear up and reminded me how lucky I am to have had her.
[shared image: a photo of a living room with a couch and a fire place] <ref:442>]
[<t:2023-01-27T09:49:00.000Z> Deborah: Hey Jolene, sorry to tell you this but my dad passed away two days ago. It's been really tough on us all - his sudden death left us all kinda shell-shocked. I'm trying to channel my grief by spending more time with family and cherishing the memories. These moments remind me to live life fully.
[shared image: a photo of a woman hugging a woman who is sitting on a couch] <ref:236>]
[<t:2023-01-23T16:06:00.000Z> Deborah: It was full of memories, she passed away a few years ago. This is our last photo together.
[shared image: a photo of a woman in a wheelchair hugging a woman in a wheelchair] <ref:14>]
[<t:2023-02-22T16:12:00.000Z> Deborah lost her friend Karlie the week before this session and has been grieving the loss. <ref:706>]
```

### Item 5: conv-49 cat1

- Question: What kind of car does Evan drive?
- Gold: Prius
- Evidence dia/chunks: ['D1:2', 'D1:4', 'D18:1', 'D18:3', 'D22:2'] / [12, 17, 176, 184, 273]
- Hybrid: tokens=134, chunkIds=[604, 588, 78, 474, 415], goldExactPresent=True, evidenceChunksPresent=[]
- Magma: tokens=258, chunkIds=[604, 588, 78, 474, 415], goldExactPresent=True, evidenceChunksPresent=[]
- Context differs: True. Retrieval-set differs: False.
- Anchor retention: hybridTop=604, hybridTopRetained=True, hybridTop5Retained=5/5; baseAnchorTop20=[604, 588, 78, 474, 415, 476, 510, 546, 508, 605, 515, 17, 271, 355, 582, 183, 206, 293, 176, 4]; magmaTopVisited=[604, 588, 78, 474, 415].
- Traversal debug: intent=ENTITY, anchorCount=20, visitedCount=60, traversedCount=40, reachedByDepth=[8, 8, 8, 8, 8], reachedByType={'entity': 40, 'semantic': 0, 'temporal': 0, 'causal': 0}, traversedAbsentFromHybridCount=40.
- Sample traversed nodes absent from hybrid top-5: [{'id': 205, 'excerpt': "Evan: Absolutely, Sam. My family means the world to me. They're my rock. I'm looking forward to expanding our family and creating even more beautiful memories."}, {'id': 314, 'excerpt': "Sam: Agree, Evan! Family is everything - they bring so much love and happiness. They're always there for us no matter what. I'm grateful for their support and love."}]

Hybrid context (unelided):

```text
Relevant SCNS memories:
Evan took his Prius for a long drive to the mountains last weekend and got into a minor car accident on the way back, but he and his companions were unharmed.

Evan's new Prius, which he had recently bought, broke down, leaving him without his main mode of transport for his active lifestyle and road trips.

Evan: Ready for an adventure? Where will you go?

Evan: Thanks! I love being in places like this - it brings back memories of road tripping in my trusty car.
[shared image: a photography of a truck parked in the middle of a forest]

Evan: Catch ya later!
```

Magma context (unelided):

```text
Relevant SCNS memories:
[<t:2023-12-31T11:00:00.000Z> Evan took his Prius for a long drive to the mountains last weekend and got into a minor car accident on the way back, but he and his companions were unharmed. <ref:604>]
[<t:2023-12-05T20:16:00.000Z> Evan's new Prius, which he had recently bought, broke down, leaving him without his main mode of transport for his active lifestyle and road trips. <ref:588>]
[<t:2023-10-14T16:07:00.000Z> Evan: Ready for an adventure? Where will you go? <ref:78>]
[<t:2023-08-19T18:17:00.000Z> Evan: Thanks! I love being in places like this - it brings back memories of road tripping in my trusty car.
[shared image: a photography of a truck parked in the middle of a forest] <ref:474>]
[<t:2023-08-07T19:52:00.000Z> Evan: Catch ya later! <ref:415>]
```

## Cross-item findings

- Magma and hybrid contexts differ textually on every probed item, but only because magma uses Stage-4 serialization (`[<t:...> ... <ref:id>]`). The returned chunk IDs are identical for all 5/5 probed items.
- Magma does not include causal-neighbor chunks absent from hybrid in the final injected context for these items. The debug traversal reaches 40 non-anchor nodes per item (60 visited = 20 anchors + 40 traversed), but `magmaTopVisited` equals the hybrid top-5 each time, so traversed nodes are discarded before context injection.
- Causal edges exist in the snapshot and are connected to the anchor pools, but were not actually admitted by the beam on these live native-QA probes: causalAll/causalFromAnchorTop20/reachedByType were: conv-48 cat4 32/1/{entity:40,semantic:0,temporal:0,causal:0}; conv-49 cat4 84/3/{entity:0,semantic:0,temporal:40,causal:0}; conv-50 cat4 100/7/{entity:40,semantic:0,temporal:0,causal:0}; conv-48 cat1 32/5/{entity:40,semantic:0,temporal:0,causal:0}; conv-49 cat1 84/3/{entity:40,semantic:0,temporal:0,causal:0}.
- Runtime anchor retention is verified on these items: hybrid top-1 retained 5/5; hybrid top-5 retained 5/5. The single-hop gold answer was present in magma for 2/3 single-hop probes and absent in both hybrid and magma for the Jolene/pets item; I did not observe a case where hybrid contained the direct single-hop gold but magma displaced it.

## Conclusion

Faithful MAGMA retrieval is **not fully manifesting in the magma arm output**. The production path is reachable (`traverse:true` enters `adaptiveTraversalSearch`) and the debug loop visits non-anchor nodes, so this is not a total pass-through. However, the final injected magma contexts for the sampled native QA items have exactly the same chunk IDs as hybrid; the extra 126 mean tokens/query are Stage-4 timestamp/ref scaffolding over the same anchors, not added causal-neighbor evidence. More importantly for the T030 reproduction premise, the beam admitted zero causal-edge nodes in these probes despite materialized causal edges in the snapshot and some causal edges from the anchor pools.

## Recommendation

**BLOCKED.** The 0.5911 null should be treated as **INCONCLUSIVE**, not a valid `NOT_REPRODUCED` verdict. Missing precondition: the magma arm must demonstrate that Algorithm-1 traversal over the materialized causal substrate changes the injected retrieval context (or at least admits causal-edge nodes into the serialized context) while retaining anchors. Current runtime evidence shows anchor retention and Stage-4 formatting, but no causal-edge contribution to the final magma context; the judged run is effectively hybrid top-5 plus provenance scaffolding.

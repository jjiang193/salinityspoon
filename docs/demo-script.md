# Demo Script

Ninety seconds, rehearsed. The order matters: hook first, mechanism second,
proof last.

---

## Before judging

- [ ] EC probe calibrated (two-point), curve fit loaded, validated against a
      solution not used in the fit
- [ ] Scoop volume calibrated for whoever is holding the spoon
- [ ] **A recording captured and replay tested** — `tools/replay.py`
- [ ] Two cups prepared (see the taste test below)
- [ ] Dashboard on the big screen, browser zoomed so it reads from 2 m
- [ ] Backend on `0.0.0.0`, spoon and laptop on the same network
- [ ] Probe rinsed in **distilled water only**

**If hardware fails:** start the replay loop and run the same script. Do not
announce it.

```bash
python tools/replay.py backend/recordings/<file>.jsonl --loop
```

---

## 1. The hook (15 s) — do this first, with a judge

Two cups of broth. One is saltier.

> "Taste both. Don't tell me which is saltier — tell me **how much** saltier."

Then measure both and show the numbers.

Ask for *magnitude*, never direction. People are poor at estimating how much
saltier something is even when they correctly identify which. Asking the harder
question means the demo lands whether or not they guess right.

Then the line that makes it matter:

> "Salt taste sensitivity declines with age. The people who most need to control
> sodium are the least able to taste it. That's the gap."

## 2. What it does (20 s)

Dip the spoon. A bite appears on the dashboard.

> "Conductivity, temperature and motion. The accelerometer isn't decoration —
> it decides which readings are allowed to count. A probe waved through air
> reads zero; a probe in a liquid being stirred reads turbulence. We sample at
> 100 Hz through a 16-bit ADC, take the median of about fifty samples per
> scoop, and throw away the first 150 milliseconds because the probe lies while
> it's wetting."

Point at `Recent bites` → the **Samples** column.

> "Every bite shows how many samples it was built from. You can see which ones
> to trust."

## 3. The differentiator (20 s) — the strongest 20 seconds you have

Set the label claim to **Low sodium**. Dip into the salty broth.

The card flags: *Possible potassium-based salt substitute.*

> "Conductivity can't tell sodium from potassium. Normally that's a limitation.
> But salt substitutes *are* potassium chloride — so a product labelled
> low-sodium that measures this much ionic content is probably substituting.
>
> For someone with kidney disease, or on an ACE inhibitor, that's a
> hyperkalemia risk. **No food database can detect this. No barcode app can.
> Only a conductivity measurement can.**
>
> We flag it. We don't diagnose it."

That last sentence is not modesty — it is the thing that makes the claim
credible.

## 4. Honesty (15 s) — do not skip this

Point at the range under the headline number.

> "We never show a bare number. Per bite we're about ±27%; per meal about ±10%,
> because random scoop variation cancels across thirty bites. The sensor
> dominates that budget, not our volume estimate."

Then, if there is hot liquid to hand, dip into it:

> "The probe is rated to 40 °C. Above that we refuse to record — not a flagged
> reading, no reading. The compensation was never characterised up there, so any
> number would be unsupported rather than just imprecise. We'd rather show
> nothing than show something we can't defend."

Point at `Log solid food`.

> "It reads liquids only, so solids are entered by hand and labelled
> self-reported. Today that's 1,040 mg self-reported against 870 mg measured —
> we'd be blind to more than half the day if we pretended otherwise."

## 5. Close (10 s)

> "Passive per-bite sodium tracking, with a pace cue on the device and a trend
> a clinician can act on. It's monitoring and trends — not diagnosis."

---

## Anticipated questions

**"A five-dollar salt pen already does this."**
A pen is one manual reading you have to remember to take. This logs every bite
passively, trends it, and nudges in real time. The value is the loop, not the
reading.

**"Is that exact sodium?"**
No, and we never claim it is. It's NaCl-equivalent salinity with a stated range.
Conductivity reads all ions. What adherence needs is a trend, not a lab number.

**"Why not weigh each bite?"**
We did the error propagation. Scoop variation cancels as √n, so the meal total is
about ±4.6% from volume alone — the sensor dominates the budget. A load cell
would attack the smaller term, and in a handheld spoon grip force couples into
the beam in a way you cannot tare out.

**"Does it capture my whole diet?"**
No. Liquids with the device, solids entered by hand. Objective partial monitoring
still beats the recall diaries clinicians rely on now.

**"Why does it refuse to measure hot soup?"**
The probe is rated 0–40 °C. We enforce it rather than extrapolate past it.

**"What was the hardest part?"**
See `engineering-notes.md` — a real scoop is half a second, which breaks every
settle-based approach. We solved it by sampling faster rather than trusting less.

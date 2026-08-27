/**
 * Telling a drift from a reading.
 *
 * Two points always define a rate — that is the whole problem with them. Two
 * unrelated titles reported large drift within a day of each other: a 2008
 * home rip at 3.24%, which the viewer could hear, and a commercial release
 * with six language tracks and forty-two subtitle tracks at 6.86%, which
 * would put its audio two minutes early by the end and be unusable on every
 * player ever made. One of those is a fault. The other is a reading.
 *
 * A third point tells them apart: a genuine mastering drift is LINEAR — the
 * same slope in the first half of the session as in the second — and nothing
 * is corrected until that has been shown. This exercises the arithmetic that
 * decides, lifted out of probeOutput so the branch under test is the shipped
 * one.
 */
const fs = require('fs');
const PATHS = require('./paths.js');
const SRC = PATHS.SERVER;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const source = fs.readFileSync(SRC, 'utf8');

/**
 * The decision, as shipped. Lifted by locating the block rather than
 * re-typing it, so a change to the real thing shows up here.
 */
const start = source.indexOf('    let halfEarly = null;');
const end = source.indexOf('    return {', start);
if (start < 0 || end < 0) throw new Error('the linearity block moved');
const block = source.slice(start, end);

// The block declares `mid` itself, so the sample is handed in under another
// name and gapOf is the identity — the arithmetic under test is untouched.
const judge = (early, sample, late, driftRate) => {
  const fn = new Function('early', 'midway', 'late', 'driftRate', `
    const gapOf = (x) => x;
    ${block}
    return { halfEarly, halfLate, driftLinear };
  `);
  return fn(early, sample, late, driftRate);
};

/** A perfectly linear drift, sampled at three points. */
const linearRun = (rate, t0, t1, t2) => ({
  early: { gap: rate * t0, vEnd: t0 },
  mid: { gap: rate * t1, vEnd: t1 },
  late: { gap: rate * t2, vEnd: t2 },
});

console.log('\n  a genuine drift is a straight line');
{
  // The archive rip the viewer could actually hear.
  const r = linearRun(-0.0324, 10, 150, 289);
  const out = judge(r.early, r.mid, r.late, -0.0324);
  console.log(`   halves: ${(out.halfEarly * 1000).toFixed(1)}ms/s then `
    + `${(out.halfLate * 1000).toFixed(1)}ms/s`);
  check('the two halves agree, so it is corrected', out.driftLinear === true,
    JSON.stringify(out));
  check('and both report the real rate',
    Math.abs(out.halfEarly + 0.0324) < 1e-9 && Math.abs(out.halfLate + 0.0324) < 1e-9,
    JSON.stringify(out));
}

console.log('\n  a reading is not');
{
  // The shape an artefact takes: a gap that appears at one end of the session
  // and is not a slope at all. Same two endpoints as a -6.86% straight line,
  // so a two-point measurement cannot tell the difference — which is the
  // entire reason the third point exists.
  const early = { gap: 0, vEnd: 8 };
  const mid = { gap: -0.05, vEnd: 26 };        // essentially flat so far
  const late = { gap: -2.424, vEnd: 43.835 };  // then the whole gap at once
  const twoPoint = (late.gap - early.gap) / (late.vEnd - early.vEnd);
  const out = judge(early, mid, late, twoPoint);
  console.log(`   two points would have said ${(twoPoint * 100).toFixed(2)}%`);
  console.log(`   halves: ${(out.halfEarly * 1000).toFixed(1)}ms/s then `
    + `${(out.halfLate * 1000).toFixed(1)}ms/s`);
  check('two points alone would have called this a 6.9% drift',
    Math.abs(twoPoint * 100 + 6.8) < 0.3, String(twoPoint * 100));
  check('three points refuse it', out.driftLinear === false, JSON.stringify(out));
  check('so a good film is never played several percent slow for its length',
    out.driftLinear !== true);
}

console.log('\n  and it is not so strict that real drift is missed');
{
  // Real measurements are not perfect. A drift with ordinary noise on it
  // still has to pass, or the corroboration has simply switched the feature
  // off under a nicer name.
  const early = { gap: 0.31, vEnd: 10 };
  const mid = { gap: -4.20, vEnd: 150 };     // ~ -0.0322/s with noise
  const late = { gap: -9.03, vEnd: 289 };    // ~ -0.0347/s with noise
  const rate = (late.gap - early.gap) / (late.vEnd - early.vEnd);
  const out = judge(early, mid, late, rate);
  console.log(`   halves: ${(out.halfEarly * 1000).toFixed(1)}ms/s then `
    + `${(out.halfLate * 1000).toFixed(1)}ms/s`);
  check('a noisy but real drift is still corrected', out.driftLinear === true,
    JSON.stringify(out));
}

console.log('\n  when it cannot be judged, it is not judged');
{
  const early = { gap: 0, vEnd: 10 };
  const late = { gap: -0.5, vEnd: 30 };
  const out = judge(early, null, late, -0.025);
  check('no middle point means no verdict, not a pass',
    out.driftLinear === null, JSON.stringify(out));

  // Two samples a moment apart are two readings of the same instant.
  const tooClose = judge({ gap: 0, vEnd: 10 }, { gap: -0.05, vEnd: 11 },
    { gap: -0.5, vEnd: 30 }, -0.025);
  check('and halves too short to mean anything are refused as well',
    tooClose.driftLinear === null, JSON.stringify(tooClose));
}

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);

/**
 * A studio is not a director.
 *
 * "for some of the cast and crew listings it isnt listing the correct actors
 *  or directors, it is listing the production companys which I dont need to
 *  see. This is what was the result for 'analyze this (1999)'
 *    Spring Creek Productions — Director
 *    Tribeca Productions — Director
 *    Baltimore Pictures — Director
 *    Warner Bros. Pictures — Director"
 *
 * The provider writes the production companies into `director` on a good many
 * films, and the box believed it: four companies, four circles with initials
 * in them, four directors, and Harold Ramis — who actually directed it —
 * nowhere on the page.
 *
 * THE DISPLAY IS THE SMALLER HALF. Every film anybody opens teaches the
 * credits index, and a shared DIRECTOR is the strongest signal the
 * recommender has — worth more than a shared actor, because a director is a
 * choice and a character actor is in ninety films. So an index that believes
 * Warner Bros. Pictures directed nine hundred films quietly decides all nine
 * hundred are by the same person, and For You leans on that.
 *
 * THE BAR IS NEVER TO DROP A REAL PERSON. A company left in is one bad row on
 * one page; a director taken out is a fact destroyed and a worse
 * recommendation for as long as the index lives. So anything ambiguous stays,
 * and the singular words a person's name might plausibly end in — `film`,
 * `picture` — are deliberately not matched at all.
 */
const people = require('../people.js');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

/* The four off the film that was reported, plus the shapes around them. */
const COMPANIES = [
  'Spring Creek Productions', 'Tribeca Productions', 'Baltimore Pictures',
  'Warner Bros. Pictures', 'Warner Bros.', 'Studio Ghibli', 'Miramax Films',
  'Pixar Animation Studios', 'The Weinstein Company', 'Amblin Entertainment',
  'Canal+ International', 'BBC Films', 'Lionsgate Television',
  'Village Roadshow Pictures', 'Some Holding Inc', 'Another One Ltd.',
  'Constantin Film Produktion GmbH', 'Gaumont Distribution',
];

/*
 * Real people, and the ones near a word on the list are the point.
 *
 * Wes Studi is an actor — Dances with Wolves, The Last of the Mohicans — and
 * "Studi" sits one letter from "Studio". Markie Post is an actress and "post
 * production" is the phrase that would have caught her. Both are here because
 * a rule that drops them is worse than no rule.
 */
const PEOPLE = [
  'Harold Ramis', 'Robert De Niro', 'Billy Crystal', 'Lisa Kudrow',
  'Wes Studi', 'Markie Post', 'Martin Scorsese', 'Ridley Scott',
  'Park Chan-wook', 'Ang Lee', 'Denis Villeneuve', 'Jean-Pierre Jeunet',
  'Kathryn Bigelow', 'Bong Joon-ho', 'Sofia Coppola', 'Guillermo del Toro',
  'Mary Pickford', 'Peter Weir', 'Chloé Zhao', 'Taika Waititi',
];

(async () => {
  console.log('\n  telling one from the other');
  const dropped = PEOPLE.filter((n) => people.isCompany(n));
  const kept = COMPANIES.filter((n) => !people.isCompany(n));
  console.log('   people wrongly dropped:', JSON.stringify(dropped));
  console.log('   companies let through :', JSON.stringify(kept));
  /* The claim that matters most, stated on its own so a failure names it. */
  check('no real person is mistaken for a company',
    dropped.length === 0, JSON.stringify(dropped));
  check('and the companies are recognised', kept.length === 0, JSON.stringify(kept));

  /* ---- the film that was reported --------------------------------------- */
  /*
   * Exactly what the provider sends for Analyze This, with the man who
   * directed it put back where he belongs.
   */
  console.log('\n  Analyze This (1999)');
  const info = {
    director: 'Harold Ramis, Spring Creek Productions, Tribeca Productions, '
      + 'Baltimore Pictures, Warner Bros. Pictures',
    cast: 'Robert De Niro, Billy Crystal, Lisa Kudrow, Chazz Palminteri',
  };
  const read = people.peopleIn(info);
  console.log('   directors:', JSON.stringify(read.directors));
  console.log('   cast:     ', JSON.stringify(read.cast));
  check('the four studios are gone',
    read.directors.length === 1, JSON.stringify(read.directors));
  /* And the point of doing it by exclusion rather than by taking the first
     name: the real director survives. */
  check('and the man who directed it is what is left',
    read.directors[0] === 'Harold Ramis', JSON.stringify(read.directors));
  check('the cast is untouched', read.cast.length === 4, JSON.stringify(read.cast));

  /* ---- a film whose director is ONLY companies -------------------------- */
  /*
   * Some entries carry no person at all. An empty director list is the honest
   * answer — the box does not know who directed it — and is a great deal
   * better than four wrong ones.
   */
  console.log('\n  and one with nothing but studios in the field');
  const none = people.peopleIn({ director: 'Warner Bros. Pictures, Legendary Entertainment',
    cast: 'Somebody Real' });
  console.log('   ', JSON.stringify(none));
  check('it says it knows of no director, rather than naming a studio',
    none.directors.length === 0, JSON.stringify(none.directors));
  check('while the cast still stands', none.cast.length === 1, JSON.stringify(none.cast));

  /* ---- and the index does not go on insisting --------------------------- */
  /*
   * The damage is already written down: every film opened before this had its
   * studios filed as directors, in the file the recommender reads. A fix that
   * only applied to films nobody had looked at yet would leave a thousand
   * crawled ones still claiming Warner Bros. Pictures directed them.
   */
  console.log('\n  an index written before the fix');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-'));
  const file = path.join(dir, 'people.json');
  fs.writeFileSync(file, JSON.stringify({
    shape: people.SHAPE,
    at: Date.now(),
    films: {
      941: { c: ['Robert De Niro', 'Billy Crystal'],
        d: ['Harold Ramis', 'Warner Bros. Pictures', 'Tribeca Productions'],
        at: Date.now() },
      942: { c: ['Somebody Else'], d: ['Village Roadshow Pictures'], at: Date.now() },
    },
    faces: {},
  }));
  const lines = [];
  people.load(file, (line) => lines.push(line));
  console.log('   ', JSON.stringify(lines));
  const one = people.creditsFor('941');
  const two = people.creditsFor('942');
  console.log('   941:', JSON.stringify(one));
  console.log('   942:', JSON.stringify(two));
  check('the studios are swept out of what was already stored',
    one.directors.length === 1 && one.directors[0] === 'Harold Ramis',
    JSON.stringify(one.directors));
  check('including a film left with no director at all',
    two.directors.length === 0, JSON.stringify(two.directors));
  check('and it says how many it cleaned', lines.some((l) => /studios taken out of 2/.test(l)),
    JSON.stringify(lines));
  /* The lookup the recommender actually makes. A company that is still
     findable by name is still tying films together. */
  check('and a studio is no longer a name you can look films up by',
    people.filmsWith('Warner Bros. Pictures').length === 0,
    JSON.stringify(people.filmsWith('Warner Bros. Pictures')));
  check('while the real director still finds his film',
    people.filmsWith('Harold Ramis').includes('941'),
    JSON.stringify(people.filmsWith('Harold Ramis')));

  console.log(`\n  ${fails.length ? `FAILED: ${fails.join(', ')}` : 'all good'}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

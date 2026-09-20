import * as sev from '../lib/severity';

/**
 * The spoon has gone quiet in the middle of a meal, said at the top of the page.
 *
 * Render it only while a meal is open, the server can be reached, and samples
 * have stopped. It is the same state as sev.spoonLink's critical chip and takes
 * its words from it, so it carries the same tier and earns no colour of its
 * own. It sits in the alert slot beside the interlock because it is the same
 * order of failure: every dip is being lost, and the figures under it are the
 * last ones rather than the current ones. It used to be a chip in the third
 * card, a long scroll down on a phone.
 */
export function SpoonSilentBanner({ silentForS }: { silentForS: number }) {
  const { label } = sev.spoonLink({ live: false, silentForS, inMeal: true });
  return (
    <div className="banner-critical" role="alert">
      {/* The count ticks every second; an alert that re-announced each tick
          would never stop talking. */}
      <strong aria-live="off">{label}.</strong>{' '}
      Dips are not being recorded, and the numbers below are from before it went
      quiet. Check the spoon is switched on.
    </div>
  );
}

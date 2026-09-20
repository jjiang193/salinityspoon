import { LabelCheck } from '../types';

/**
 * A contradicted label, said at the top of the page.
 *
 * Render it only while `check.flagged`. This is the one clinical message the
 * portal carries - a product labelled low in sodium that measures like ordinary
 * broth is probably a potassium-chloride substitute - and it used to sit below
 * everything else, a long scroll down on a phone.
 *
 * Tier: the same attention/critical that LabelCheckCard and MealsTable already
 * give a flagged label. It is moved up the page, not newly coloured.
 *
 * What to do is said in the sentence everyone sees, not only inside the closed
 * details: a critical message that names a problem and no action is half a one.
 *
 * The explanation is the server's, word for word. It ends by saying this is a
 * flag and not a diagnosis; do not paraphrase it.
 */
export function LabelFlagAlert({ check }: { check: LabelCheck }) {
  return (
    <div className="banner-critical" role="alert">
      <strong>{check.headline}.</strong>{' '}
      {check.product_name ?? 'This bowl'} measures
      {/* Whole multiples, as the server's own sentence below prints them. */}
      {check.ratio !== null ? ` about ${check.ratio.toFixed(0)}× ` : ' well above '}
      its {check.claim_label.toLowerCase()} claim.{' '}
      Check the ingredients for potassium chloride before finishing it.
      <details>
        <summary>What this means</summary>
        <p>{check.detail}</p>
      </details>
    </div>
  );
}

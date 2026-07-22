/**
 * One page for two situations: there is nothing here, and there is something
 * here that is not yours.
 *
 * It has to be one page. If a missing artifact and a private one looked
 * different, anybody could tell which artifact ids exist by trying them, and a
 * private artifact would confirm its own existence to a stranger. The server
 * already answers identically for both; this page is the other half of that
 * promise, and splitting it into two friendlier messages would undo it.
 *
 * So the wording covers both honestly rather than guessing which one happened.
 */

import { Link } from '../router.jsx';

export function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center px-6">
      <div className="oa-rise max-w-[380px] text-center">
        <h1 className="text-[15px]">This is not here</h1>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
          Either nothing exists at this address, or it does and it has not been shared with the
          account you are signed in to.
        </p>
        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">
          If somebody sent you this link, check you are signed in with the address they used.
        </p>
        <Link
          to="/"
          className="mt-5 inline-block text-[12.5px] font-medium text-accent hover:underline"
        >
          Go to your artifacts
        </Link>
      </div>
    </div>
  );
}

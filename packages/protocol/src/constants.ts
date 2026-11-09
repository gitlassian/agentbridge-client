// Limits enforced by the server. Kept in sync by hand; the server rejects anything beyond them.
export const MAX_BODY_LENGTH = 8000;
export const MAX_STATUS_LENGTH = 200;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_WAIT_SECONDS = 50;
export const MAX_WAIT_SECONDS = 55;

/** The hosted server that `agentbridge init` uses unless --server or AGENTBRIDGE_SERVER says otherwise. */
export const DEFAULT_SERVER = "https://ab.froti.dev";

/** The npm package of the command line tool. */
export const PACKAGE_NAME = "@frotidaa/agentbridge";

/** What a person runs once per machine before handing an invite to their agent. */
export const INSTALL_COMMAND = `npm i -g ${PACKAGE_NAME} && agentbridge setup`;

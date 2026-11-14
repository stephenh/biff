// Personal preferences shared by the browser and daemon. Keep this module free of runtime dependencies.

/** These authors stay visible without requiring reader acknowledgement; logins are case-insensitive. */
export const autoReadCommentAuthors = ["linear-code[bot]", "homebound-team-bot", "greptile-apps[bot]"];

/** Exact paths are repository-relative; names and suffixes apply in every directory. */
export const autoReviewedFiles = {
  paths: [
    "schema.graphql",
    "yarn.lock",
    "schema/enums.graphql",
    "graphql-codegen-joist.mjs",
    "src/resolvers/enumResolvers.ts",
    "src/entities/entities.ts",
    "src/entities/codegen/metadata-docs.ts",
  ],
  names: [".history.json", "metadata.ts"],
  suffixes: ["Codegen.ts"],
};

/** Saved browser settings override these defaults. */
export const readingDefaults = {
  font: "Geist Mono Variable",
  size: 22,
  collapseDeleted: true,
};

/** Main and frozen panes share the same diff appearance. */
export const diffDisplay = {
  theme: "pierre-dark",
  lineDiffType: "word-block",
} as const;

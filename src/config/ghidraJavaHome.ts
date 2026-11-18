/** Select a Ghidra-only JDK without changing Java for other applications. */
export const selectGhidraJavaHome = (environment: {
  readonly REA_GHIDRA_JAVA_HOME?: string | undefined;
  readonly JAVA_HOME?: string | undefined;
}): string | undefined =>
  environment.REA_GHIDRA_JAVA_HOME ?? environment.JAVA_HOME;

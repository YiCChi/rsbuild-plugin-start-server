import { defineConfig } from 'oxfmt';

export default defineConfig({
  printWidth: 80,
  singleQuote: true,
  insertFinalNewline: true,
  embeddedLanguageFormatting: 'auto',
  ignorePatterns: [
    '.agents/**/*',
    '.claude/**/*',
    'graphify-out/**/*',
    'dev/saml-idp/stage-toaster-realm.json',
  ],
  sortImports: true,
});

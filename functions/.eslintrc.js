module.exports = {
  env: {
    es2021: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "google",
  ],
  parserOptions: {
    ecmaVersion: 2021,
  },
  rules: {
    "no-restricted-globals": ["error", "name", "length"],
    "prefer-arrow-callback": "error",
    "quotes": ["error", "double", {"allowTemplateLiterals": true}],
    "require-jsdoc": "off",
    "max-len": "off",
    "no-unused-vars": "warn",
  },
  overrides: [
    {
      files: ["**/*.spec.*"],
      env: {mocha: true},
      rules: {},
    },
  ],
  root: true,
};

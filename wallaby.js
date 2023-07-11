module.exports = (wallaby) => {
  return {
    files: [
      'src/**/*.ts',
      'test/**/*.ts',
      '!test/**/*.spec.ts'
    ],
    tests: [
      'test/unit/**/*.spec.ts'
    ],

    workers: {
      initial: 1,
      regular: 1,
      restart: true
    },

    testFramework: 'mocha',
    env: {
      type: 'node'
    }
  };
};
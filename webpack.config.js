const webpack = require('webpack');
const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const SentryPlugin = require('@sentry/webpack-plugin');

const pjson = require('./package.json');

const OUTPUT_DIR = path.resolve(__dirname, 'bundle');

module.exports = {
    entry: {
        index: './src/index.ts',
        'error-tracking': './src/error-tracking.ts'
    },
    output: {
        path: OUTPUT_DIR,
        filename: '[name].js',
        libraryTarget: 'commonjs2'
    },
    mode: 'production',
    devtool: 'source-map',
    target: 'node',
    node: {
        __dirname: false
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/
            },
            {
                // Required to build .mjs files correctly
                test: /\.mjs$/,
                include: /node_modules/,
                type: "javascript/auto",
            }
        ]
    },
    externals: [
        '@oclif/plugin-update/lib/commands/update', // Lots of complicated dynamic requires in @oclif
        'registry-js', // Native module
        'win-version-info' // Native module
    ],
    plugins: [
        // Optimistic require for 'iconv' in 'encoding', falls back to 'iconv-lite'
        new webpack.NormalModuleReplacementPlugin(/\/iconv-loader$/, 'node-noop'),
        // Optimistically required in (various) ws versions, with fallback
        new webpack.IgnorePlugin(/^bufferutil$/),
        // Optimistically required in (various) ws versions, with fallback
        new webpack.IgnorePlugin(/^utf-8-validate$/),
        // Optimistically required in headless, falls back to child_process
        new webpack.IgnorePlugin(/^child-killer$/),
        // Copy Mockttp's schema (read with readFile) into the output directory
        new CopyWebpackPlugin([
            { from: path.join('node_modules', 'mockttp', 'dist', 'standalone', 'schema.gql') }
        ]),
        // If SENTRY_AUTH_TOKEN is set, upload this sourcemap to Sentry
        process.env.SENTRY_AUTH_TOKEN
            ? new SentryPlugin({
                release: pjson.version,
                include: OUTPUT_DIR,
                validate: true
            })
            : { apply: () => {} },
        // Used to e.g. fix the relative path to the overrides directory
        new webpack.EnvironmentPlugin({ HTK_IS_BUNDLED: true })
    ],
    resolve: {
        extensions: [ '.tsx', '.ts', '.js' ]
    }
};

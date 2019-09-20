const webpack = require('webpack');
const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
    entry: {
        index: './src/index.ts',
        'error-tracking': './src/error-tracking.ts'
    },
    output: {
        path: path.resolve(__dirname, 'bundle'),
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
            },
            {
                // Allows us to require native modules
                test: /\.node$/,
                loader: "native-ext-loader"
            }
        ]
    },
    externals: [
        '@oclif/plugin-update/lib/commands/update'
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
        ])
    ],
    resolve: {
        extensions: [ '.tsx', '.ts', '.js' ]
    }
};

// Test built-ins against their specific protocol
require('http').get('http://example.com/js/http');
require('https').get('https://example.com/js/https');

function sendRequestsTo(baseUrl) {
    require('request').get(baseUrl + '/request');
    require('axios').get(baseUrl + '/axios');
    require('superagent').get(baseUrl + '/superagent').end(() => {});
    require('node-fetch')(baseUrl + '/node-fetch');
    require('got')(baseUrl + '/got');
    require('bent')('GET')(baseUrl + '/bent')
    require('unirest').get(baseUrl + '/unirest', () => {});
    require('reqwest')(baseUrl + '/reqwest');
    require('needle').get(baseUrl + '/needle', () => {});
}

// Test all other libs against both protocols
sendRequestsTo('http://example.com/js');
sendRequestsTo('https://example.com/js');

// Test libraries that need manual steps, and use their own URLs:
require('stripe')('sk_test_hunter2').customers.list();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const environment = {
    DB_HOST: 'test.invalid', DB_PORT: '3307', DB_USER: 'test-user',
    DB_PASSWORD: 'test-password', DB_NAME: 'test-db', SESSION_SECRET: 'test-secret'
};

function load(env = environment) {
    const routes = new Map();
    const app = { set() {}, use() {}, listen() {}, get() {}, put() {}, delete() {}, post(path, ...handlers) { routes.set(path, handlers); } };
    const express = Object.assign(() => app, { static() {}, urlencoded() {}, json() {} });
    const state = { routes, dotenvLoaded: false };
    const pool = Object.assign(new EventEmitter(), { query() { assert.fail('Unexpected pool query'); }, getConnection() { assert.fail('Unexpected connection request'); } });
    const dependencies = {
        express,
        mysql2: { createPool(config) { state.poolConfig = config; return pool; } },
        'express-session': (config) => { state.sessionConfig = config; },
        dotenv: { config() { state.dotenvLoaded = true; } }
    };
    vm.runInNewContext(source, {
        require: (name) => name in dependencies ? dependencies[name] : require(name),
        process: { env }, console: { log() {}, error() {} }
    }, { filename: 'app.js' });
    return { ...state, pool };
}

function response() {
    const res = new EventEmitter();
    res.redirect = (path) => { res.location = path; res.emit('finish'); };
    res.json = (data) => { res.data = data; res.emit('finish'); };
    return res;
}

function request(body = {}) {
    return { body, params: { id: 2 }, session: { user: { id: 1, role: 'admin' } }, flash() {} };
}

function run(loaded, path, req = request(), res = response()) {
    const handlers = [...loaded.routes.get(path)];
    const next = (error) => { if (error) throw error; handlers.shift()?.(req, res, next); };
    next();
    return res;
}

const loaded = load();
assert.equal(loaded.dotenvLoaded, true);
assert.deepEqual(JSON.parse(JSON.stringify(loaded.poolConfig)), {
    host: environment.DB_HOST, port: 3307, user: environment.DB_USER,
    password: environment.DB_PASSWORD, database: environment.DB_NAME, connectionLimit: 1
});
// Exercise mysql2's real release path without opening a network connection.
const actualPool = require('mysql2').createPool(loaded.poolConfig);
actualPool.on('release', loaded.pool.listeners('release')[0]);
let destroyed = 0;
const idleConnection = {
    _pool: actualPool,
    destroy() {
        destroyed++;
        this._pool = null;
        actualPool._removeConnection(this);
    }
};
actualPool._connectionQueue.push((error, connection) => {
    assert.equal(error, null);
    assert.equal(connection, idleConnection);
    assert.equal(destroyed, 0, 'Queued queries must retain the connection');
    actualPool.releaseConnection(connection);
    assert.equal(destroyed, 1, 'An idle connection must be destroyed immediately');
    assert.equal(actualPool._freeConnections.length, 0);
    actualPool.end();
});
actualPool.releaseConnection(idleConnection);
assert.equal(destroyed, 0);

assert.equal(loaded.sessionConfig.secret, environment.SESSION_SECRET);
assert.equal(load({ ...environment, DB_PORT: undefined }).poolConfig.port, 3306);
for (const name of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'SESSION_SECRET']) {
    assert.throws(() => load({ ...environment, [name]: '' }), new RegExp(name));
}
for (const port of ['abc', '0', '65536', '3307.5']) {
    assert.throws(() => load({ ...environment, DB_PORT: port }), /DB_PORT/);
}

const member = { username: 'test', email: 'test@example.com', gender: 'other', dob: '2000-01-01', contact: '12345678', address: 'test', password: 'test-password' };
for (const role of ['admin', undefined]) {
    const queries = [];
    loaded.pool.query = (sql, values, callback) => {
        queries.push({ sql, values });
        callback(null, sql.startsWith('SELECT') ? [] : { insertId: 1 });
    };
    assert.equal(run(loaded, '/register', request({ ...member, role })).location, '/login');
    assert.equal(queries.length, 2);
    assert.equal(queries[1].values[5], 'user');
    assert.equal(queries[1].values[6], 'other');
}
loaded.pool.query = (sql, values, callback) => callback(new Error('Database unavailable'));
assert.equal(run(loaded, '/register', request(member)).location, '/register');

// Every existing transaction route must use its checked-out connection, then release it once.
for (const path of ['/billing/add-funds', '/billing/select-plan', '/billing/switch-plan', '/admin/members/:id/delete']) {
    const events = [];
    loaded.pool.query = () => assert.fail('Transaction escaped its connection');
    const connection = {
        query(sql, values, callback) {
            events.push('query');
            let rows = { affectedRows: 1 };
            if (sql.startsWith('SELECT username')) rows = [{ username: 'member' }];
            else if (sql.includes('FROM membership_subscriptions')) rows = path.includes('switch-plan') ? [{ subscription_id: 1, plan_id: 1, plan_name: 'Old' }] : [];
            else if (sql.includes('FROM membership_plans')) rows = [{ price: 10, plan_name: 'New' }];
            else if (sql.includes('FROM wallet')) rows = [{ balance: 100 }];
            callback(null, rows);
        },
        beginTransaction(callback) { events.push('begin'); callback(null); },
        commit(callback) { events.push('commit'); callback(null); },
        rollback(callback) { events.push('rollback'); callback(); },
        release() { events.push('release'); }, destroy() { events.push('destroy'); }
    };
    loaded.pool.getConnection = (callback) => callback(null, connection);
    const res = run(loaded, path, request({ amount: '10', planId: 2 }));
    assert.ok(events.includes('begin'), path);
    assert.deepEqual(events.slice(-2), ['commit', 'release'], path);
    res.emit('close');
    assert.equal(events.filter((event) => event === 'release').length, 1);
    assert.equal(events.includes('destroy'), false);
}

// Failed and interrupted transactions must never return an open transaction to the pool.
for (const interrupted of [false, true]) {
    const events = [];
    loaded.pool.getConnection = (callback) => callback(null, {
        beginTransaction(done) { done(); },
        query(sql, values, done) { if (!interrupted) done(new Error('Query failed')); },
        rollback(done) { events.push('rollback'); done(); },
        release() { events.push('release'); }, destroy() { events.push('destroy'); }
    });
    const res = run(loaded, '/billing/add-funds', request({ amount: '10' }));
    res.emit('close');
    assert.deepEqual(events, interrupted ? ['destroy'] : ['rollback', 'release']);
}
const connectionError = new Error('Cannot acquire connection');
loaded.pool.getConnection = (callback) => callback(connectionError);
assert.throws(() => run(loaded, '/billing/add-funds'), (error) => error === connectionError);

const schema = fs.readFileSync(require.resolve('../database-script/dbscript.sql'), 'utf8');
assert.match(schema, /ENUM\('Male', 'Female', 'Other'\)/);
assert.doesNotMatch(schema, /^USE\s/m);
console.log('Configuration, registration, and pooled transaction checks passed (no network).');

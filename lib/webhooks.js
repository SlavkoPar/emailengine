'use strict';

const { redis, notifyQueue } = require('./db');
const msgpack = require('msgpack5')();
const logger = require('./logger');
const { REDIS_PREFIX } = require('./consts');
const vm = require('vm');
const settings = require('./settings');

let pfStructuredClone = typeof structuredClone === 'function' ? structuredClone : data => JSON.parse(JSON.stringify(data));

class WebhooksHandler {
    constructor(options) {
        this.options = options || {};
        this.redis = this.options.redis;

        this.handlerCache = [];
        this.handlerCacheV = 0;
    }

    getWebhooksIndexKey() {
        return `${REDIS_PREFIX}wh:i`;
    }

    getWebhooksContentKey() {
        return `${REDIS_PREFIX}wh:c`;
    }

    async list(page, pageSize) {
        page = Math.max(Number(page) || 0, 0);
        pageSize = Math.max(Number(pageSize) || 20, 1);

        let startPos = page * pageSize;

        let webhookIds = await this.redis.smembers(this.getWebhooksIndexKey());
        webhookIds = [].concat(webhookIds || []).sort((a, b) => -a.localeCompare(b));

        let response = {
            total: webhookIds.length,
            pages: Math.ceil(webhookIds.length / pageSize),
            page,
            webhooks: []
        };

        if (webhookIds.length <= startPos) {
            return response;
        }

        let keys = webhookIds.slice(startPos, startPos + pageSize).flatMap(id => [`${id}:meta`]);
        let list = await this.redis.hmgetBuffer(this.getWebhooksContentKey(), keys);
        for (let entry of list) {
            try {
                let webhookMeta = msgpack.decode(entry);
                response.webhooks.push(webhookMeta);
            } catch (err) {
                logger.error({ msg: 'Failed to process webhook', entry: entry.toString('base64') });
                continue;
            }
        }

        return response;
    }

    async generateId() {
        let idNum = await this.redis.hincrby(this.getWebhooksContentKey(), 'id', 1);

        let idBuf = Buffer.alloc(8 + 4);
        idBuf.writeBigUInt64BE(BigInt(Date.now()), 0);
        idBuf.writeUInt32BE(idNum, 8);

        return idBuf.toString('base64url');
    }

    unpackId(id) {
        let idBuf = Buffer.from(id, 'base64');
        return {
            counter: idBuf.readUInt32BE(8),
            created: new Date(Number(idBuf.readBigUInt64BE(0))).toISOString()
        };
    }

    async create(meta, content) {
        const id = await this.generateId();

        let entry = Object.assign({ id: null }, meta || {}, {
            id,
            created: new Date().toISOString()
        });

        let insertResult = await this.redis
            .multi()
            .sadd(this.getWebhooksIndexKey(), id)
            .hmset(this.getWebhooksContentKey(), {
                [`${id}:meta`]: msgpack.encode(entry),
                [`${id}:content`]: msgpack.encode(content),
                [`${id}:v`]: 1
            })
            .hincrby(this.getWebhooksContentKey(), `v`, 1)
            .exec();

        let hasError = (insertResult[0] && insertResult[0][0]) || (insertResult[1] && insertResult[1][0]);
        if (hasError) {
            throw hasError;
        }

        return {
            created: true,
            id
        };
    }

    async update(id, meta, content) {
        let metaBuf = await this.redis.hgetBuffer(this.getWebhooksContentKey(), `${id}:meta`);
        if (!metaBuf) {
            let err = new Error('Document was not found');
            err.code = 'NotFound';
            err.statusCode = 404;
            throw err;
        }

        let existingMeta = msgpack.decode(metaBuf);

        let entry = Object.assign(existingMeta, meta || {}, {
            id: existingMeta.id,
            created: existingMeta.created,
            updated: new Date().toISOString()
        });

        let updates = {
            [`${id}:meta`]: msgpack.encode(entry)
        };

        if (content) {
            updates[`${id}:content`] = msgpack.encode(content);
        }

        let insertResult = await this.redis
            .multi()
            .sadd(this.getWebhooksIndexKey(), id)
            .hmset(this.getWebhooksContentKey(), updates)
            .hincrby(this.getWebhooksContentKey(), `${id}:v`, 1)
            .hincrby(this.getWebhooksContentKey(), `v`, 1)
            .exec();

        let hasError = (insertResult[0] && insertResult[0][0]) || (insertResult[1] && insertResult[1][0]);
        if (hasError) {
            throw hasError;
        }

        return {
            updated: true,
            id
        };
    }

    async getMeta(id) {
        let getResult = await this.redis.hmgetBuffer(this.getWebhooksContentKey(), [`${id}:meta`]);
        if (!getResult || getResult.length !== 1 || !getResult[0]) {
            return false;
        }

        let meta;

        try {
            if (getResult[0]) {
                meta = msgpack.decode(getResult[0]);
            }
        } catch (err) {
            logger.error({ msg: 'Failed to process webhook', entry: getResult[0].toString('base64') });
        }

        return Object.assign({}, meta || {});
    }

    async get(id) {
        let getResult = await this.redis.hmgetBuffer(this.getWebhooksContentKey(), [
            `${id}:meta`,
            `${id}:content`,
            `${id}:v`,
            `${id}:webhookErrorFlag`,
            `${id}:tcount`
        ]);
        if (!getResult || !getResult[0] || !getResult[1]) {
            return false;
        }

        let meta, content, webhookErrorFlag, v, tcount;

        try {
            if (getResult[0]) {
                meta = msgpack.decode(getResult[0]);
            }
        } catch (err) {
            logger.error({ msg: 'Failed to process webhook', entry: getResult[0].toString('base64') });
        }

        try {
            if (getResult[1]) {
                content = msgpack.decode(getResult[1]);
            }
        } catch (err) {
            logger.error({ msg: 'Failed to process webhook', entry: getResult[1].toString('base64') });
        }

        v = Number(getResult[2] && getResult[2].toString()) || 0;

        try {
            if (getResult[3]) {
                webhookErrorFlag = JSON.parse(getResult[3].toString());
            }
        } catch (err) {
            logger.error({ msg: 'Failed to process webhook', entry: getResult[3].toString('base64') });
        }

        tcount = Number(getResult[4] && getResult[4].toString()) || 0;

        return Object.assign({}, meta || {}, { content, v, webhookErrorFlag, tcount });
    }

    async del(id) {
        let deleteResult = await this.redis
            .multi()
            .srem(this.getWebhooksIndexKey(), id)
            .hdel(this.getWebhooksContentKey(), [`${id}:meta`, `${id}:content`])
            .hincrby(this.getWebhooksContentKey(), `v`, 1)
            .exec();

        let hasError = (deleteResult[0] && deleteResult[0][0]) || (deleteResult[1] && deleteResult[1][0]);
        if (hasError) {
            throw hasError;
        }

        let deletedDocs = ((deleteResult[0] && deleteResult[0][1]) || 0) + ((deleteResult[1] && deleteResult[1][1]) || 0);

        return {
            deleted: deletedDocs === 3, // any other count means something went wrong
            id
        };
    }

    async flush() {
        let deleteResult = await this.redis
            .multi()
            .del(this.getWebhooksIndexKey())
            .hget(this.getWebhooksContentKey(), 'id')
            .del(this.getWebhooksContentKey())
            .exec();

        let hasError = (deleteResult[0] && deleteResult[0][0]) || (deleteResult[1] && deleteResult[1][0]) || (deleteResult[2] && deleteResult[2][0]);
        if (hasError) {
            throw hasError;
        }

        let idVal = deleteResult[1][1];
        if (idVal) {
            await this.redis.hset(this.getWebhooksContentKey(), 'id', idVal);
        }

        return {
            flushed: true
        };
    }

    async getHandler(id) {
        let webhookData = await this.get(id);

        try {
            if (webhookData.content.fn) {
                webhookData.compiledFn = new vm.Script(`result = (()=>{${webhookData.content.fn}})(payload);`);
            } else {
                webhookData.compiledFn = false;
            }
        } catch (err) {
            logger.error({ msg: 'Compilation failed', type: 'filter', webhook: id, err });
            webhookData.compiledFn = null;
            webhookData.compiledMap = null;
        }

        if (webhookData.compiledFn) {
            try {
                if (webhookData.content.map) {
                    webhookData.compiledMap = new vm.Script(`result = (()=>{${webhookData.content.map}})(payload);`);
                } else {
                    webhookData.content.map = false;
                }
            } catch (err) {
                logger.error({ msg: 'Compilation failed', type: 'map', webhook: id, err });
                webhookData.compiledFn = null;
                webhookData.compiledMap = null;
            }
        }

        if (webhookData.compiledFn) {
            webhookData.filterFn = payload => {
                let ctx = {
                    result: false,
                    payload: pfStructuredClone(payload)
                };
                try {
                    vm.createContext(ctx);
                    webhookData.compiledFn.runInContext(ctx);
                    return ctx.result;
                } catch (err) {
                    logger.error({ msg: 'Exec failed', type: 'filter', webhook: webhookData.id, err });
                    return null;
                }
            };
        }

        if (webhookData.compiledMap) {
            webhookData.mapFn = payload => {
                let ctx = {
                    result: false,
                    payload: pfStructuredClone(payload)
                };
                try {
                    vm.createContext(ctx);
                    webhookData.compiledMap.runInContext(ctx);
                    return ctx.result;
                } catch (err) {
                    logger.error({ msg: 'Exec failed', type: 'map', webhook: webhookData.id, err });
                    return null;
                }
            };
        }

        return webhookData;
    }

    async getWebhookHandlers() {
        let v = await this.redis.hget(this.getWebhooksContentKey(), 'v');
        v = Number(v) || 0;
        if (v !== this.handlerCacheV) {
            // changes detected
            v = this.handlerCacheV;

            let webhookIds = await this.redis.smembers(this.getWebhooksIndexKey());
            webhookIds = [].concat(webhookIds || []).sort((a, b) => -a.localeCompare(b));

            // remove deleted from cache
            for (let i = this.handlerCache.length - 1; i >= 0; i--) {
                if (!webhookIds.includes(this.handlerCache[i].id)) {
                    this.handlerCache.splice(i, 1);
                }
            }

            for (let webhookId of webhookIds) {
                let existing = this.handlerCache.find(c => c.id === webhookId);
                if (!existing) {
                    // add as new
                    let handler = await this.getHandler(webhookId);
                    this.handlerCache.push(handler);
                } else {
                    // compare existing
                    let webhookV = await this.redis.hget(this.getWebhooksContentKey(), `${webhookId}:v`);
                    if (existing.v !== webhookV) {
                        // update
                        for (let i = this.handlerCache.length - 1; i >= 0; i--) {
                            if (webhookId === this.handlerCache[i].id) {
                                let handler = await this.getHandler(webhookId);
                                this.handlerCache[i] = handler;
                            }
                        }
                    }
                }
            }
        }

        return this.handlerCache;
    }

    async formatPayload(event, originalPayload) {
        // run all normalizations before sending the data

        const payload = pfStructuredClone(originalPayload);

        if (event === 'messageNew' && payload && payload.data && payload.data.text) {
            // normalize text content
            let notifyText = await settings.get('notifyText');
            if (!notifyText) {
                // remove text content if any
                for (let key of Object.keys(payload.data.text)) {
                    if (!['id', 'encodedSize'].includes(key)) {
                        delete payload.data.text[key];
                    }
                }
                if (!Object.keys(payload.data.text).length) {
                    delete payload.data.text;
                }
            } else {
                let notifyTextSize = await settings.get('notifyTextSize');
                if (notifyTextSize) {
                    for (let textType of ['html', 'plain']) {
                        if (payload.data.text && typeof payload.data.text[textType] === 'string' && payload.data.text[textType].length > notifyTextSize) {
                            payload.data.text[textType] = payload.data.text[textType].substr(0, notifyTextSize);
                            payload.data.text.hasMore = true;
                        }
                    }
                }
            }
        }

        if (event === 'messageNew' && payload && payload.data && payload.data.headers) {
            // normalize headers
            let notifyHeaders = await settings.get('notifyHeaders');
            if (!notifyHeaders) {
                delete payload.data.headers;
            } else if (!notifyHeaders.includes('*')) {
                // filter unneeded headers
                for (let header of Object.keys(payload.data.headers || {})) {
                    if (!notifyHeaders.includes(header.toLowerCase())) {
                        delete payload.data.headers[header];
                    }
                }
            }

            if (!Object.keys(payload.data.headers).length) {
                delete payload.data.headers;
            }
        }

        return payload;
    }

    async pushToQueue(event, originalPayload, opts = {}) {
        // custom webhoom routes
        let webhookRoutes = await this.getWebhookHandlers();
        let queueKeep = (await settings.get('queueKeep')) || true;

        for (let route of webhookRoutes) {
            if (route.enabled && route.targetUrl && typeof route.filterFn === 'function') {
                let canSend;
                let payload = pfStructuredClone(originalPayload);

                payload._route = {
                    id: route.id
                };

                try {
                    canSend = route.filterFn(payload);
                } catch (err) {
                    logger.error({ msg: 'Exec failed', type: 'filter', webhook: route.id, err });
                }

                if (canSend) {
                    if (typeof route.mapFn === 'function') {
                        try {
                            payload._route.mapping = route.mapFn(payload);
                        } catch (err) {
                            logger.error({ msg: 'Exec failed', type: 'map', webhook: route.id, err });
                            canSend = false;
                        }
                    }
                }

                if (canSend && payload) {
                    let job = await notifyQueue.add(event, payload, {
                        removeOnComplete: queueKeep,
                        removeOnFail: queueKeep,
                        attempts: 10,
                        backoff: {
                            type: 'exponential',
                            delay: 5000
                        }
                    });

                    logger.trace({
                        msg: 'Triggered custom webhook route',
                        event,
                        webhook: route.id,
                        job: job.id
                    });

                    try {
                        await this.redis.hincrby(this.getWebhooksContentKey(), `${route.id}:tcount`, 1);
                    } catch (err) {
                        logger.error({ msg: 'Failed to increment counter', event, job: job.id, webhook: route.id, err });
                    }
                }
            }
        }

        if (!opts.routesOnly) {
            // MAIN webhook
            await notifyQueue.add(event, originalPayload, {
                removeOnComplete: queueKeep,
                removeOnFail: queueKeep,
                attempts: 10,
                backoff: {
                    type: 'exponential',
                    delay: 5000
                }
            });
        }
    }
}

module.exports.webhooks = new WebhooksHandler({ redis });
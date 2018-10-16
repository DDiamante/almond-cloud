// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2018 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

require('thingengine-core/lib/polyfill');
process.on('unhandledRejection', (up) => { throw up; });

const stream = require('stream');
const seedrandom = require('seedrandom');

const exampleModel = require('../model/example');

const BinaryPPDB = require('../util/binary_ppdb');
const SentenceGenerator = require('./sentence-generator');
const AdminThingpediaClient = require('../util/admin-thingpedia-client');
const { coin, uniform, choose } = require('../util/random');

const db = require('../util/db');

// NOTE: to ensure consistency wrt concurrent database modifications by other processes,
// this script executes everything inside a single transaction
//
// this is quite dangerous: this transaction can last for minutes
// if another transaction tries to read a row that is locked by this one, it will timeout
// and be rolled back (which the calling code usually handles but it results in a 500 error
// and bad user experience)
//
// hence, in modifying this code you must pay attention to the semantics of InnoDB locking
// and SQL isolation modes
// to learn more, see: https://dev.mysql.com/doc/refman/8.0/en/innodb-transaction-isolation-levels.html#isolevel_repeatable-read
//
// specifically, we operate in READ COMMITTED mode
// this means that only the rows that we modify (insert/delete) are locked, and none of
// the reads apply any lock
// (MySQL's default is REPEATABLE READ, but our default is SERIALIZABLE, which is the only sane default)
//
// in turn, this means
// - if the database is concurrently modified, the dataset we generate might not correspond
//   to any consistent snapshot (instead, it will be a hybrid of before and after the modification)
//   this can cause TypeErrors as we try and load invalid templates, or it can cause invalid
//   sentences to be generated
//   this is acceptable because any database modification will queue a new update job and we'll
//   discard our work and start again
// - if two instances of the script run at once, they will insert all sentences twice, as they would delete the
//   same rows and then insert fresh rows to replace them
//   don't do that

class DatasetUpdater {
    constructor(language, forDevices, options) {
        this._language = language;
        this._options = options;
        this._rng = seedrandom.alea('almond is awesome');

        // TODO: use this for incremental updates
        this._forDevices = forDevices;

        this._ppdb = null;
        this._dbClient = null;
    }

    async _clearExistingDataset() {
        if (this._options.regenerateAll) {
            await db.query(this._dbClient, `delete from example_utterances where language = ? and (type = 'generated' or
                find_in_set('augmented', flags) or find_in_set('replaced', flags))`, [this._language]);
        } else {
            await db.query(this._dbClient, `delete from example_utterances where language = ? and type = 'generated'`, [this._language]);
        }
    }

    async _insertExampleBatch(examples) {
        return exampleModel.createMany(this._dbClient, examples.map((ex) => {
            return {
                utterance: ex.preprocessed,
                preprocessed: ex.preprocessed,
                target_code: ex.target_code,
                target_json: '',
                type: ex.type,
                flags: ex.flags,
                is_base: 0,
                language: this._language
            };
        }));
    }

    _applyPPDB(examples, prob) {
        const output = [];

        for (let ex of examples) {
            let inSpan = false;
            let spanWords = new Set;
            for (let tok of ex.target_code.split(' ')) {
                if (tok === '"')
                    inSpan = !inSpan;
                else if (inSpan)
                    spanWords.add(tok);
            }

            const sentence = ex.preprocessed.split(' ');
            const replaceable = new Map;
            for (let word of sentence) {
                if (spanWords.has(word))
                    continue;

                let replacements = this._ppdb.get(word);
                if (replacements.length > 0)
                    replaceable.set(word, replacements);
            }

            if (replaceable.size === 0) {
                if (this._options.debug)
                    console.log(`ppdb: skipped ${ex.id} (no replaceable words found)`);
                continue;
            }
            let toreplace;
            if (replaceable.size === 1)
                toreplace = Array.from(replaceable.keys());
            else
                toreplace = choose(Array.from(replaceable.keys()), 2, this._rng);

            if (!coin(prob, this._rng))
                continue;

            const newUtterance = sentence.map((word) => {
                if (toreplace.indexOf(word) >= 0)
                    return uniform(replaceable.get(word), this._rng);
                else
                    return word;
            }).join(' ');

            output.push({
                flags: ex.flags ? ex.flags + ',augmented' : 'augmented',
                type: ex.type,
                utterance: newUtterance,
                preprocessed: newUtterance,
                target_code: ex.target_code
            });
        }

        return output;
    }

    async _processSyntheticMinibatch(objs) {
        if (objs.length === 0)
            return;

        objs.forEach((o) => {
            delete o.id;
            o.type = 'generated';
            o.flags = 'synthetic';
            o.preprocessed = o.utterance;
        });
        await Promise.all([
            this._insertExampleBatch(objs),
            this._insertExampleBatch(this._applyPPDB(objs, this._options.ppdbProbabilitySynthetic))
        ]);
    }

    async _genSynthetic() {
        const options = {
            rng: this._rng,
            language: this._language,
            dbClient: this._dbClient,
            thingpediaClient: new AdminThingpediaClient(this._language, this._dbClient),
            turkingMode: false,
            maxDepth: this._options.maxDepth,
            debug: false
        };

        const generator = new SentenceGenerator(options);
        const writer = new stream.Writable({
            objectMode: true,
            highWaterMark: 100,

            write: (obj, encoding, callback) => {
                this._processSyntheticMinibatch([obj]).then(() => callback(null), (err) => callback(err));
            },
            writev: (objs, callback) => {
                this._processSyntheticMinibatch(objs.map((o) => o.chunk)).then(() => callback(null), (err) => callback(err));
            }
        });
        generator.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    }

    async _transaction() {
        await this._clearExistingDataset();
        await this._genSynthetic();
    }

    async run() {
        this._ppdb = await BinaryPPDB.mapFile(this._options.ppdbFile);

        return db.withTransaction((dbClient) => {
            this._dbClient = dbClient;
            return this._transaction();
        }, 'read committed');
    }
}


async function main() {
    const [language, forDevices] = process.argv.slice(2);

    const updater = new DatasetUpdater(language, forDevices, {
        regenerateAll: true,
        maxDepth: 3,

        ppdbFile: './ppdb-2.0-m-lexical.bin',
        ppdbProbabilitySynthetic: 0.1,
        ppdbProbabilityGenerated: 1.0
    });
    await updater.run();

    await db.tearDown();
}
main();


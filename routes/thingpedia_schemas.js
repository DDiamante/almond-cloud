// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Thingpedia
//
// Copyright 2015 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const express = require('express');

const ThingTalk = require('thingtalk');

const db = require('../util/db');
const user = require('../util/user');
const deviceModel = require('../model/device');
const schemaModel = require('../model/schema');
const exampleModel = require('../model/example');

const SchemaUtils = require('../util/manifest_to_schema');
const DatasetUtils = require('../util/dataset');
const I18n = require('../util/i18n');

var router = express.Router();

function getOrgId(req) {
    if (!req.user)
        return null;
    if (req.user.developer_status >= user.DeveloperStatus.ADMIN)
        return -1;
    else
        return req.user.developer_org;
}

router.get('/by-id/:kind', (req, res, next) => {
    const language = req.query.language || (req.user ? I18n.localeToLanguage(req.user.locale) : 'en');
    db.withClient(async (dbClient) => {
        const orgId = getOrgId(req);
        const [devices, schemas] = await Promise.all([
            deviceModel.getFullCodeByPrimaryKind(dbClient, req.params.kind, orgId),
            schemaModel.getMetasByKinds(dbClient, [req.params.kind], orgId, language),
        ]);
        if (devices.length === 0 || schemas.length === 0) {
            res.status(404).render('error', { page_title: req._("Thingpedia - Error"),
                                              message: req._("Not Found.") });
            return;
        }
        const classDef = ThingTalk.Grammar.parse(devices[0].code);
        const schema = schemas[0];
        SchemaUtils.mergeClassDefAndSchema(classDef, schema);

        let [translated, examples] = await Promise.all([
            language === 'en' ? true : schemaModel.isKindTranslated(dbClient, req.params.kind, language),
            exampleModel.getByKinds(dbClient, [req.params.kind], getOrgId(req), language),
        ]);

        const row = {
            owner: devices[0].owner,
            approved_version: devices[0].approved_version,
            developer_version: devices[0].developer_version,
            kind: req.params.kind,
            translated: translated,
            code: classDef.prettyprint(),
            dataset: DatasetUtils.examplesToDataset(req.params.kind, 'en', examples,
                                                    { editMode: true })
        };

        res.render('thingpedia_schema', { page_title: req._("Thingpedia - Type detail"),
                                          csrfToken: req.csrfToken(),
                                          schema: row });
    }).catch(next);
});

module.exports = router;

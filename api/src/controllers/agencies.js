/**
 * @summary APIs for the Update Issuing Agency page.
 * @description This file contains API endpoints for loading and updating agency names from the database.
 */

const mongoose = require('mongoose');

const queryActions = require('../utils/query-actions');
const RECORD_TYPE = require('../utils/constants/record-type-enum');
const defaultLog = require('../utils/logger')('record');

let agencyCodeByName = new Map();
let agencyResolverOperation = Promise.resolve();

/**
 * Serializes resolver refreshes and agency renames within this Node.js process.
 * This is intentionally a single-replica guarantee; multi-replica deployments
 * require a database-backed lock or equivalent cross-process coordination.
 */
async function withAgencyResolverLock(operation) {
  const previousOperation = agencyResolverOperation;
  let releaseLock;
  agencyResolverOperation = new Promise(resolve => {
    releaseLock = resolve;
  });

  await previousOperation;
  try {
    return await operation();
  } finally {
    releaseLock();
  }
}

function buildAgencyCodeMap(agencyDocuments) {
  const refreshedMap = new Map();

  agencyDocuments.forEach(agency => {
    if (
      !agency ||
      typeof agency.agencyName !== 'string' ||
      agency.agencyName.trim().length === 0 ||
      typeof agency.agencyCode !== 'string' ||
      agency.agencyCode.trim().length === 0
    ) {
      throw new Error('Malformed ApplicationAgency mapping');
    }

    const existingCode = refreshedMap.get(agency.agencyName);
    if (existingCode && existingCode !== agency.agencyCode) {
      throw new Error(`Conflicting agency codes for display name: ${agency.agencyName}`);
    }
    refreshedMap.set(agency.agencyName, agency.agencyCode);
  });

  if (refreshedMap.size === 0) {
    throw new Error('No ApplicationAgency mappings were found');
  }

  return refreshedMap;
}

async function loadAgencyCodeMap(collectionDB) {
  const agencyDocuments = await collectionDB.find({ _schemaName: RECORD_TYPE.ApplicationAgency._schemaName }).toArray();
  return buildAgencyCodeMap(agencyDocuments);
}

/**
 * Atomically refreshes the synchronous agency resolver from the authoritative
 * ApplicationAgency records. The previous map remains active if the database
 * read fails.
 *
 * @param {Object} collectionDB MongoDB nrpti collection (injectable for tests)
 * @returns {number} number of agency mappings loaded
 */
exports.refreshAgencyCodeMap = async function (collectionDB = mongoose.connection.db.collection('nrpti')) {
  return withAgencyResolverLock(async () => {
    const refreshedMap = await loadAgencyCodeMap(collectionDB);
    agencyCodeByName = refreshedMap;
    return agencyCodeByName.size;
  });
};

/**
 * Resolves the current display name to its stable agency code. Unknown names
 * return null so publication logic continues to fail closed.
 *
 * @param {string} agencyName
 * @returns {string|null}
 */
exports.getAgencyCodeFromName = function (agencyName) {
  return agencyCodeByName.get(agencyName) || null;
};

async function renameAgency(collectionDB, agencyCode, agencyName) {
  const agencyDocuments = await collectionDB.find({ _schemaName: RECORD_TYPE.ApplicationAgency._schemaName }).toArray();
  const currentAgency = agencyDocuments.find(agency => agency.agencyCode === agencyCode);
  if (!currentAgency) {
    throw new Error(`Unknown agency code: ${agencyCode}`);
  }

  const updatedAgencyDocuments = agencyDocuments.map(agency =>
    agency.agencyCode === agencyCode ? { ...agency, agencyName } : agency
  );
  buildAgencyCodeMap(updatedAgencyDocuments);

  await collectionDB.findOneAndUpdate(
    { agencyCode },
    {
      $set: { agencyName }
    }
  );

  try {
    const refreshedMap = await loadAgencyCodeMap(collectionDB);
    if (refreshedMap.get(agencyName) !== agencyCode) {
      throw new Error(`Agency rename was not persisted for code: ${agencyCode}`);
    }
    agencyCodeByName = refreshedMap;
  } catch (refreshError) {
    try {
      await collectionDB.findOneAndUpdate(
        { agencyCode },
        {
          $set: { agencyName: currentAgency.agencyName }
        }
      );
      const restoredMap = await loadAgencyCodeMap(collectionDB);
      if (restoredMap.get(currentAgency.agencyName) !== agencyCode) {
        throw new Error(`Agency rename rollback was not persisted for code: ${agencyCode}`);
      }
      agencyCodeByName = restoredMap;
    } catch (recoveryError) {
      agencyCodeByName = new Map();
      const resolverRecoveryError = new Error('Agency resolver recovery failed');
      resolverRecoveryError.refreshError = refreshError;
      resolverRecoveryError.recoveryError = recoveryError;
      throw resolverRecoveryError;
    }
    throw refreshError;
  }
}

/**
 * @async
 * @param {Object} args - Request arguments.
 * @param {Object} res - Response object.
 * @param {Function} next - Next function in the middleware chain.
 * @description Get API for retrieving agency code and names from the database.
 */
exports.publicGet = async function (args, res, next) {
  const db = mongoose.connection.db;
  const collectionDB = db.collection('nrpti');

  let agencyList;

  try {
    // Obtain documents with Application Agency Schema
    let agencyDocuments = await collectionDB.find({ _schemaName: RECORD_TYPE.ApplicationAgency._schemaName }).toArray();
    // Using map function to iterate through the original array and creates
    // a new array with objects containing only the _id, agencyCode, and agencyName properties.
    agencyList = agencyDocuments.map(item => ({
      _id: item._id,
      agencyCode: item.agencyCode,
      agencyName: item.agencyName
    }));
  } catch (error) {
    defaultLog.log(error);
    throw error;
  }

  queryActions.sendResponse(res, 200, agencyList);
};

/**
 * @async
 * @param {Object} args - Request arguments.
 * @param {Object} res - Response object.
 * @param {Function} next - Next function in the middleware chain.
 * @description Put API for updating agency names in the database.
 * @param {Object} incomingObj - Incoming object with agency code and the new name to update.
 * @returns {string} - Result message ('Success' or 'Error').
 * @example
 *   // Example of args.swagger.params.data.value
 *   {
 *       "agencies":
 *       [
 *           {
 *               "agencyCode": "AGENCY_ALC",
 *               "agencyName": "Agricultural Land Commission_1"
 *           }
 *       ]
 *   }
 */
exports.protectedPut = async function (args, res, next) {
  const db = mongoose.connection.db;
  const collectionDB = db.collection('nrpti');
  let result = null;
  let incomingObj = args.swagger.params.data.value;
  const agencies = incomingObj['agencies'];
  try {
    await withAgencyResolverLock(async () => {
      if (agencies && agencies.length > 0) {
        await renameAgency(collectionDB, agencies[0]['agencyCode'], agencies[0]['agencyName']);
      } else {
        const refreshedMap = await loadAgencyCodeMap(collectionDB);
        agencyCodeByName = refreshedMap;
      }
    });
    result = 'Success';
  } catch (error) {
    defaultLog.info(`protectedPut - agencies controller - error updating record: ${incomingObj}`);
    defaultLog.debug(error);
    result = 'Error';
    return queryActions.sendResponse(res, 400, {});
  }
  queryActions.sendResponse(res, 200, result);
  next();
};

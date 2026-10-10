const mongoose = require('mongoose');

const agenciesController = require('../src/controllers/agencies');

const collection = agencies => ({
  find: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue(agencies) }))
});

describe('agency code resolver', () => {
  it('loads current display names from ApplicationAgency records', async () => {
    const loaded = await agenciesController.refreshAgencyCodeMap(
      collection([{ agencyCode: 'AGENCY_ENV', agencyName: 'Ministry of Environment and Parks' }])
    );

    expect(loaded).toBe(1);
    expect(agenciesController.getAgencyCodeFromName('Ministry of Environment and Parks')).toBe('AGENCY_ENV');
    expect(agenciesController.getAgencyCodeFromName('Ministry of Environment and Climate Change Strategy')).toBeNull();
  });

  it('rejects an empty database result instead of silently disabling all display names', async () => {
    await expect(agenciesController.refreshAgencyCodeMap(collection([]))).rejects.toThrow(
      'No ApplicationAgency mappings were found'
    );
  });

  it('rejects conflicting codes for one display name', async () => {
    await expect(
      agenciesController.refreshAgencyCodeMap(
        collection([
          { agencyCode: 'AGENCY_ENV', agencyName: 'Duplicate name' },
          { agencyCode: 'AGENCY_EAO', agencyName: 'Duplicate name' }
        ])
      )
    ).rejects.toThrow('Conflicting agency codes for display name: Duplicate name');
  });

  it('rejects malformed ApplicationAgency rows instead of loading a partial map', async () => {
    await agenciesController.refreshAgencyCodeMap(
      collection([{ agencyCode: 'AGENCY_ENV', agencyName: 'Current name' }])
    );

    await expect(
      agenciesController.refreshAgencyCodeMap(
        collection([
          { agencyCode: 'AGENCY_ENV', agencyName: 'Replacement name' },
          { agencyCode: 'AGENCY_EAO', agencyName: null }
        ])
      )
    ).rejects.toThrow('Malformed ApplicationAgency mapping');
    expect(agenciesController.getAgencyCodeFromName('Current name')).toBe('AGENCY_ENV');
    expect(agenciesController.getAgencyCodeFromName('Replacement name')).toBeNull();
  });

  it('retains the last complete map when a refresh fails', async () => {
    await agenciesController.refreshAgencyCodeMap(
      collection([{ agencyCode: 'AGENCY_ENV', agencyName: 'Current name' }])
    );
    const failedCollection = {
      find: jest.fn(() => ({ toArray: jest.fn().mockRejectedValue(new Error('synthetic database failure')) }))
    };

    await expect(agenciesController.refreshAgencyCodeMap(failedCollection)).rejects.toThrow(
      'synthetic database failure'
    );
    expect(agenciesController.getAgencyCodeFromName('Current name')).toBe('AGENCY_ENV');
  });

  it('serializes concurrent renames so only one agency can claim a display name', async () => {
    const documents = [
      { _schemaName: 'ApplicationAgency', agencyCode: 'AGENCY_ALPHA', agencyName: 'Alpha' },
      { _schemaName: 'ApplicationAgency', agencyCode: 'AGENCY_BETA', agencyName: 'Beta' }
    ];
    let releaseWrites;
    const writesReleased = new Promise(resolve => {
      releaseWrites = resolve;
    });
    let signalFirstWrite;
    const firstWriteStarted = new Promise(resolve => {
      signalFirstWrite = resolve;
    });
    const nrpti = {
      find: jest.fn(() => ({
        toArray: jest.fn(async () => documents.map(document => ({ ...document })))
      })),
      findOneAndUpdate: jest.fn(async (filter, update) => {
        signalFirstWrite();
        await writesReleased;
        const agency = documents.find(document => document.agencyCode === filter.agencyCode);
        Object.assign(agency, update.$set);
        return { value: agency };
      })
    };
    const originalDb = mongoose.connection.db;
    mongoose.connection.db = { collection: jest.fn(() => nrpti) };
    const response = () => ({ writeHead: jest.fn(), end: jest.fn() });
    const alphaResponse = response();
    const betaResponse = response();
    const rename = (agencyCode, res) =>
      agenciesController.protectedPut(
        {
          swagger: {
            params: { data: { value: { agencies: [{ agencyCode, agencyName: 'Shared name' }] } } }
          }
        },
        res,
        jest.fn()
      );

    try {
      const alphaRename = rename('AGENCY_ALPHA', alphaResponse);
      const betaRename = rename('AGENCY_BETA', betaResponse);
      await firstWriteStarted;
      releaseWrites();
      await Promise.all([alphaRename, betaRename]);
    } finally {
      mongoose.connection.db = originalDb;
    }

    const statuses = [alphaResponse, betaResponse].map(res => res.writeHead.mock.calls[0][0]).sort();
    expect(statuses).toEqual([200, 400]);
    expect(documents.filter(document => document.agencyName === 'Shared name')).toHaveLength(1);
    const renamedAgency = documents.find(document => document.agencyName === 'Shared name');
    expect(agenciesController.getAgencyCodeFromName('Shared name')).toBe(renamedAgency.agencyCode);
  });

  it('rolls back a rename and restores the resolver when the authoritative refresh fails', async () => {
    const documents = [{ _schemaName: 'ApplicationAgency', agencyCode: 'AGENCY_ENV', agencyName: 'Current name' }];
    await agenciesController.refreshAgencyCodeMap(collection(documents.map(document => ({ ...document }))));
    let readCount = 0;
    const nrpti = {
      find: jest.fn(() => ({
        toArray: jest.fn(async () => {
          readCount += 1;
          if (readCount === 2) {
            throw new Error('synthetic refresh failure');
          }
          return documents.map(document => ({ ...document }));
        })
      })),
      findOneAndUpdate: jest.fn(async (filter, update) => {
        const agency = documents.find(document => document.agencyCode === filter.agencyCode);
        Object.assign(agency, update.$set);
        return { value: agency };
      })
    };
    const originalDb = mongoose.connection.db;
    mongoose.connection.db = { collection: jest.fn(() => nrpti) };
    const response = { writeHead: jest.fn(), end: jest.fn() };

    try {
      await agenciesController.protectedPut(
        {
          swagger: {
            params: {
              data: { value: { agencies: [{ agencyCode: 'AGENCY_ENV', agencyName: 'Replacement name' }] } }
            }
          }
        },
        response,
        jest.fn()
      );
    } finally {
      mongoose.connection.db = originalDb;
    }

    expect(response.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(documents[0].agencyName).toBe('Current name');
    expect(nrpti.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(agenciesController.getAgencyCodeFromName('Current name')).toBe('AGENCY_ENV');
    expect(agenciesController.getAgencyCodeFromName('Replacement name')).toBeNull();
  });

  it('clears the resolver when rollback fails after an authoritative refresh failure', async () => {
    const documents = [{ _schemaName: 'ApplicationAgency', agencyCode: 'AGENCY_ENV', agencyName: 'Current name' }];
    await agenciesController.refreshAgencyCodeMap(collection(documents.map(document => ({ ...document }))));
    let readCount = 0;
    let updateCount = 0;
    const nrpti = {
      find: jest.fn(() => ({
        toArray: jest.fn(async () => {
          readCount += 1;
          if (readCount === 2) {
            throw new Error('synthetic refresh failure');
          }
          return documents.map(document => ({ ...document }));
        })
      })),
      findOneAndUpdate: jest.fn(async (filter, update) => {
        updateCount += 1;
        if (updateCount === 2) {
          throw new Error('synthetic rollback failure');
        }
        const agency = documents.find(document => document.agencyCode === filter.agencyCode);
        Object.assign(agency, update.$set);
        return { value: agency };
      })
    };
    const originalDb = mongoose.connection.db;
    mongoose.connection.db = { collection: jest.fn(() => nrpti) };
    const response = { writeHead: jest.fn(), end: jest.fn() };

    try {
      await agenciesController.protectedPut(
        {
          swagger: {
            params: {
              data: { value: { agencies: [{ agencyCode: 'AGENCY_ENV', agencyName: 'Replacement name' }] } }
            }
          }
        },
        response,
        jest.fn()
      );
    } finally {
      mongoose.connection.db = originalDb;
    }

    expect(response.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(documents[0].agencyName).toBe('Replacement name');
    expect(agenciesController.getAgencyCodeFromName('Current name')).toBeNull();
    expect(agenciesController.getAgencyCodeFromName('Replacement name')).toBeNull();
  });

  it('rejects an unknown agency code without changing the database or resolver', async () => {
    const documents = [{ _schemaName: 'ApplicationAgency', agencyCode: 'AGENCY_ENV', agencyName: 'Current name' }];
    await agenciesController.refreshAgencyCodeMap(collection(documents.map(document => ({ ...document }))));
    const nrpti = {
      find: jest.fn(() => ({
        toArray: jest.fn(async () => documents.map(document => ({ ...document })))
      })),
      findOneAndUpdate: jest.fn()
    };
    const originalDb = mongoose.connection.db;
    mongoose.connection.db = { collection: jest.fn(() => nrpti) };
    const response = { writeHead: jest.fn(), end: jest.fn() };

    try {
      await agenciesController.protectedPut(
        {
          swagger: {
            params: {
              data: { value: { agencies: [{ agencyCode: 'AGENCY_UNKNOWN', agencyName: 'Unknown name' }] } }
            }
          }
        },
        response,
        jest.fn()
      );
    } finally {
      mongoose.connection.db = originalDb;
    }

    expect(response.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(nrpti.findOneAndUpdate).not.toHaveBeenCalled();
    expect(agenciesController.getAgencyCodeFromName('Current name')).toBe('AGENCY_ENV');
    expect(agenciesController.getAgencyCodeFromName('Unknown name')).toBeNull();
  });

  it('rejects a conflicting rename before changing the database or resolver', async () => {
    const documents = [
      { _schemaName: 'ApplicationAgency', agencyCode: 'AGENCY_ENV', agencyName: 'Current name' },
      { _schemaName: 'ApplicationAgency', agencyCode: 'AGENCY_EAO', agencyName: 'Duplicate name' }
    ];
    const nrpti = {
      find: jest.fn(() => ({ toArray: jest.fn().mockImplementation(async () => documents) })),
      findOneAndUpdate: jest.fn().mockImplementation(async (filter, update) => {
        const agency = documents.find(document => document.agencyCode === filter.agencyCode);
        Object.assign(agency, update.$set);
        return { value: agency };
      }),
      findOne: jest
        .fn()
        .mockImplementation(async filter => documents.find(document => document.agencyCode === filter.agencyCode))
    };
    const originalDb = mongoose.connection.db;
    mongoose.connection.db = { collection: jest.fn(() => nrpti) };
    await agenciesController.refreshAgencyCodeMap(nrpti);
    const response = {
      writeHead: jest.fn(),
      end: jest.fn()
    };

    try {
      await agenciesController.protectedPut(
        {
          swagger: {
            params: {
              data: { value: { agencies: [{ agencyCode: 'AGENCY_ENV', agencyName: 'Duplicate name' }] } }
            }
          }
        },
        response,
        jest.fn()
      );
    } finally {
      mongoose.connection.db = originalDb;
    }

    expect(response.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    await expect(nrpti.findOne({ agencyCode: 'AGENCY_ENV' })).resolves.toMatchObject({ agencyName: 'Current name' });
    expect(agenciesController.getAgencyCodeFromName('Current name')).toBe('AGENCY_ENV');
    expect(agenciesController.getAgencyCodeFromName('Duplicate name')).toBe('AGENCY_EAO');
  });
});

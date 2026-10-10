jest.mock('../controllers/document-controller', () => ({
  publishDocument: jest.fn(),
  publishS3Document: jest.fn(),
  unpublishDocument: jest.fn(),
  unpublishS3Document: jest.fn()
}));

const agenciesController = require('../controllers/agencies');
const BusinessLogicManager = require('./business-logic-manager');

const agencyCollection = agencies => ({
  find: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue(agencies) }))
});

describe('database-backed agency identity regressions', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await agenciesController.refreshAgencyCodeMap(
      agencyCollection([
        { _schemaName: 'ApplicationAgency', agencyCode: 'AGENCY_ENV', agencyName: 'Ministry of Environment and Parks' }
      ])
    );
  });

  it('keeps an adult Environment record publishable after the agency display name changes', () => {
    const record = {
      issuingAgency: 'Ministry of Environment and Parks',
      issuedTo: {
        type: 'Individual',
        dateOfBirth: '1980-01-01'
      }
    };

    expect(BusinessLogicManager.isRecordConsideredAnonymous(record)).toBe(false);
  });

  it('keeps a stable authorized agency code publishable without a display-name lookup', () => {
    const issuedTo = { type: 'Individual', dateOfBirth: '1980-01-01' };
    expect(BusinessLogicManager.isIssuedToConsideredAnonymous(issuedTo, 'AGENCY_ENV')).toBe(false);
  });

  it('fails closed for an unknown agency', () => {
    const issuedTo = { type: 'Individual', dateOfBirth: '1980-01-01' };
    expect(BusinessLogicManager.isIssuedToConsideredAnonymous(issuedTo, 'Unknown Ministry')).toBe(true);
  });

  it('keeps POST and PUT save preparation synchronous while applying the renamed agency rule', () => {
    const issuedTo = { type: 'Individual', dateOfBirth: '1980-01-01', read: ['sysadmin'] };
    const record = { issuingAgency: 'Ministry of Environment and Parks', issuedTo: { ...issuedTo } };
    const updateObj = { $pull: {}, $addToSet: {} };
    const postResult = BusinessLogicManager.applyBusinessLogicOnPost(record);
    const putResult = BusinessLogicManager.applyBusinessLogicOnPut(updateObj, record);

    expect(postResult).not.toBeInstanceOf(Promise);
    expect(putResult).not.toBeInstanceOf(Promise);
    expect(postResult.issuedTo.read).toContain('public');
    expect(putResult.$addToSet['issuedTo.read']).toBe('public');
  });

  it('keeps document publication aligned with the renamed agency rule', async () => {
    const DocumentController = require('../controllers/document-controller');
    DocumentController.publishDocument.mockResolvedValue({});
    const record = {
      issuingAgency: 'Ministry of Environment and Parks',
      issuedTo: { type: 'Individual', dateOfBirth: '1980-01-01' },
      documents: ['synthetic-document-id']
    };

    await BusinessLogicManager.updateDocumentRoles(record, { client_roles: ['sysadmin'] });

    expect(DocumentController.publishDocument).toHaveBeenCalledWith('synthetic-document-id', {
      client_roles: ['sysadmin']
    });
    expect(DocumentController.unpublishDocument).not.toHaveBeenCalled();
  });
});

describe('applyBusinessLogicToAct', () => {
  it('returns null if null act paramter provided ', async () => {
    const result = await BusinessLogicManager.applyBusinessLogicToAct(null);

    expect(result).toBe(null);
  });

  it('returns null if empty act parameter provided', async () => {
    const result = await BusinessLogicManager.applyBusinessLogicToAct('');

    expect(result).toBe(null);
  });

  it('returns original act if act does not match any business logic rules', async () => {
    const result = await BusinessLogicManager.applyBusinessLogicToAct('does not match business rules');

    expect(result).toEqual('does not match business rules');
  });

  it('returns altered act if act matches business logic rules', async () => {
    const result = await BusinessLogicManager.applyBusinessLogicToAct('Fisheries Act');

    expect(result).toEqual('Fisheries Act (Canada)');
  });
});

describe('updateDocumentRoles', () => {
  it('returns null if null masterRecord paramter provided ', async () => {
    const result = await BusinessLogicManager.updateDocumentRoles(null);

    expect(result).toBe(null);
  });

  it('returns null if masterRecord.documents is null', async () => {
    const result = await BusinessLogicManager.updateDocumentRoles({ documents: null });

    expect(result).toBe(null);
  });

  it('returns null if masterRecord.documents is empty', async () => {
    const result = await BusinessLogicManager.updateDocumentRoles({ documents: [] });

    expect(result).toBe(null);
  });
});

describe('isDocumentConsideredAnonymous', () => {
  it('returns true if null masterRecord paramter provided ', async () => {
    const result = await BusinessLogicManager.isDocumentConsideredAnonymous(null);

    expect(result).toBe(true);
  });

  it('returns false if masterRecord.documents is null', async () => {
    const result = await BusinessLogicManager.isDocumentConsideredAnonymous({ documents: null });

    expect(result).toBe(false);
  });

  it('returns false if masterRecord.documents is empty', async () => {
    const result = await BusinessLogicManager.isDocumentConsideredAnonymous({ documents: [] });

    expect(result).toBe(false);
  });
});

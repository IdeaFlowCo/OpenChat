import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({principal:vi.fn(),identity:vi.fn(),run:vi.fn(),write:vi.fn(),read:vi.fn()}));
vi.mock('../src/services/privateGraph.js',async()=>({...await vi.importActual('../src/services/privateGraph.js'),privateReviewPrincipal:mocks.principal}));
vi.mock('../src/services/unlinkedMessaging.js',()=>({resolveUnlinkedIdentity:mocks.identity}));
vi.mock('../src/db.js',()=>({getDriver:()=>({session:()=>({run:mocks.run,executeWrite:mocks.write,executeRead:mocks.read,close:async()=>{}})})}));
import { publishAsk } from '../src/services/askPublications.js';
const base={requestId:'synthetic-request',expectedAskRevision:0,expectedPublicationRevision:null,text:'Approved excerpt',audience:{kind:'public'},confirm:false};
beforeEach(()=>{vi.clearAllMocks();mocks.principal.mockResolvedValue({app:'openchat',ownerKey:'a'.repeat(64)});mocks.run.mockResolvedValue({records:[]});});
describe('publication input and unresolved-recipient boundary',()=>{
  it.each([{requestId:undefined},{text:''},{expectedAskRevision:undefined},{expectedPublicationRevision:undefined},{ownerKey:'forged'},{audience:{kind:'people',targets:[{kind:'name',id:'Vlad'}]}}])('rejects invalid request before identity or database work: %j',async patch=>{
    await expect(publishAsk('owner','owner:human','ask-1',{...base,...patch})).rejects.toMatchObject({status:400});
    expect(mocks.principal).not.toHaveBeenCalled();expect(mocks.run).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each(['unclaimed','unavailable'])('keeps %s identity distinct without provisioning or granting access',async status=>{
    mocks.identity.mockResolvedValue({status,name:'Synthetic person'});
    await expect(publishAsk('owner','owner:human','ask-1',{...base,audience:{kind:'people',targets:[{kind:'unlinked_profile',id:'synthetic-profile'}]}})).rejects.toMatchObject({status:status==='unclaimed'?409:503});
    expect(mocks.run).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();expect(mocks.read).not.toHaveBeenCalled();
  });
  it('does not materialize a resolved Unlinked identity into a new OpenChat account',async()=>{
    mocks.identity.mockResolvedValue({status:'member',name:'Synthetic person',identity:{issuer:'https://id.ideaflow.app/api/auth',subject:'synthetic-subject'}});
    await expect(publishAsk('owner','owner:human','ask-1',{...base,audience:{kind:'people',targets:[{kind:'unlinked_profile',id:'synthetic-profile'}]}})).rejects.toMatchObject({status:409});
    expect(mocks.run).toHaveBeenCalledOnce();expect(mocks.write).not.toHaveBeenCalled();expect(mocks.read).not.toHaveBeenCalled();
  });
});

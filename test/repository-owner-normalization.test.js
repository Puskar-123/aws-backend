const test = require("node:test"); const assert = require("node:assert/strict");
const { normalizeUserId, normalizeRepositoryMembers } = require("../services/repositoryMemberNormalizationService");
const { normalizeOwnerMemberships } = require("../scripts/normalizeRepositoryOwnerMemberships");

test("normalizes populated and raw user ids", () => {
  assert.equal(normalizeUserId({ user: { _id: "ABC" } }), "abc"); assert.equal(normalizeUserId({ _id: "ABC" }), "abc");
});
test("owner is first, active, immutable metadata and appears exactly once", () => {
  const owner = { _id: "A", username: "Puskar" }; const member = { _id: "m1", user: owner, role: "viewer", status: "suspended" };
  const result = normalizeRepositoryMembers({ owner }, [member, { user: { _id: "B" }, role: "reviewer" }], [{ user: owner, role: "write" }, { user: { _id: "B" }, role: "read" }]);
  assert.equal(result.length, 2); assert.deepEqual(result[0], { user: owner, role: "owner", status: "active", isOwner: true });
  assert.equal(result[1].role, "reviewer"); assert.equal(member.status, "suspended");
});
const query=(value)=>({select(){return this;},lean(){return this;},session(){return Promise.resolve(value);},then(resolve){return Promise.resolve(value).then(resolve);}});
test("cleanup dry run is write-free and real cleanup is idempotent",async()=>{
 const state={repositories:[{_id:"r",owner:"o",collaborators:[{user:"o",role:"read"}]}],members:[{_id:"m",repository:"r",user:"o"}],audits:[]};
 const RepositoryModel={find:()=>query(state.repositories),updateOne:async()=>{state.repositories[0].collaborators=[];}};
 const MemberModel={find:()=>query(state.members),deleteMany:async()=>{state.members=[];}}; const AuditModel={create:async(rows)=>state.audits.push(...rows)};
 const dry=await normalizeOwnerMemberships({dryRun:true,RepositoryModel,MemberModel,AuditModel}); assert.equal(dry.repositoriesChanged,1); assert.equal(state.members.length,1); assert.equal(state.audits.length,0);
 const real=await normalizeOwnerMemberships({dryRun:false,RepositoryModel,MemberModel,AuditModel}); assert.equal(real.ownerMembershipsRemoved,1); assert.equal(state.audits.length,1);
 const again=await normalizeOwnerMemberships({dryRun:false,RepositoryModel,MemberModel,AuditModel}); assert.equal(again.repositoriesChanged,0); assert.equal(state.audits.length,1);
});

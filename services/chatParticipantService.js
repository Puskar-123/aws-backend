const ConversationMember=require("../models/conversationMemberModel");
const RepositoryMember=require("../models/repositoryMemberModel");
const User=require("../models/userModel");
const permission=require("./chatPermissionService");
const {resolveRepositoryPermissionContext,getEffectiveMembershipStatus,getRepositoryRole}=require("./repositoryPermissionService");
const {normalizeId}=require("./presenceService");

const safeUser=value=>value?{_id:value._id,username:value.username||"",name:value.name||"",avatarUrl:value.avatarUrl||"",lastSeenAt:value.lastSeenAt||null}:null;
function addParticipant(map,user,role){const key=normalizeId(user);if(!key||map.has(key))return;map.set(key,{user:safeUser(user)||{_id:key},role:role||"participant"});}

async function getAuthorizedConversationParticipants(conversationOrId,{ConversationMemberModel=ConversationMember,RepositoryMemberModel=RepositoryMember,UserModel=User,...deps}={}){
  const access=deps.skipViewerCheck?{conversation:typeof conversationOrId==="object"?conversationOrId:await (deps.ConversationModel||require("../models/conversationModel")).findById(conversationOrId)}:await permission.assertCanViewConversation(conversationOrId,deps.viewerId||deps.userId||null,deps);
  const conversation=access.conversation,map=new Map();
  if(["direct","mentor"].includes(conversation.type)){
    const rows=await ConversationMemberModel.find({conversation:conversation._id,archivedAt:null}).populate("user","_id username name avatarUrl lastSeenAt").lean();
    rows.forEach(row=>addParticipant(map,row.user,row.memberRole));
    return[...map.values()];
  }
  const repositoryId=await permission.repositoryContext(conversation,deps),context=await resolveRepositoryPermissionContext(repositoryId,deps.viewerId||deps.userId,{skipExpirationWrite:true,...deps.repositoryDependencies});
  const owner=await UserModel.findById(context.repository.owner).select("_id username name avatarUrl lastSeenAt").lean();
  addParticipant(map,owner||context.repository.owner,"owner");
  const memberships=await RepositoryMemberModel.find({repository:repositoryId,status:{$ne:"suspended"}}).populate("user","_id username name avatarUrl lastSeenAt").lean();
  for(const membership of memberships){const status=getEffectiveMembershipStatus(membership,context.repository);const role=getRepositoryRole(context.repository,membership.user,membership);if(role&&!["not_started"].includes(status))addParticipant(map,membership.user,role);}
  return[...map.values()];
}

module.exports={safeUser,addParticipant,getAuthorizedConversationParticipants};

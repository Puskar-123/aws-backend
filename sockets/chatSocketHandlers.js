const chat=require("../services/chatService");
const permission=require("../services/chatPermissionService");
const presence=require("../services/presenceService");
const {getAuthorizedConversationParticipants}=require("../services/chatParticipantService");
const Block=require("../models/chatBlockModel");
const {assertRate}=require("../services/chatRateLimitService");

const typing=new Map(),activeViews=new Map();
const room=id=>`conversation:${id}`;
const ackError=(ack,error)=>typeof ack==="function"&&ack({success:false,error:error.code||"CHAT_ERROR",message:error.status?error.message:"Unable to complete chat request"});
const viewing=(user,conversation)=>activeViews.get(String(user))?.has(String(conversation))||false;
const debug=(message,data={})=>{if(process.env.NODE_ENV!=="production")console.info(`[chat] ${message}`,data);};

async function getConversationPresence(conversation,userId,options={}){const participants=await getAuthorizedConversationParticipants(conversation,{viewerId:userId,...options}),participantIds=participants.map(value=>presence.normalizeId(value.user)).filter(Boolean);return{conversationId:String(conversation._id),memberCount:new Set(participantIds).size,onlineCount:presence.getOnlineCount(participantIds),participants};}

function installChatHandlers(namespace,socket){
  const userId=socket.userId;
  socket.join(`user:${userId}`);
  const socketCount=presence.addSocket(userId,socket.id);
  socket.emit("chat:connected",{success:true,userId});
  namespace.to(`presence:${userId}`).emit("presence:changed",{userId,online:true});
  debug("socket connected",{userId,socketCount});

  const stopTyping=(conversationId,broadcast=true)=>{const key=`${conversationId}:${userId}`,timer=typing.get(key);if(timer)clearTimeout(timer);typing.delete(key);if(broadcast)socket.to(room(conversationId)).emit("typing:stopped",{conversationId,userId});};
  const broadcastConversationPresence=async conversation=>{if(!["repository","issue","pull_request","mentor"].includes(conversation.type))return null;const data=await getConversationPresence(conversation,userId);namespace.to(room(conversation._id)).emit("conversation:presence",data);debug("presence count updated",{conversationId:data.conversationId,memberCount:data.memberCount,onlineCount:data.onlineCount});return data;};

  socket.on("conversation:join",async(payload={},ack)=>{try{
    const access=await permission.assertCanViewConversation(payload.conversationId,userId),conversationId=String(access.conversation._id);
    socket.join(room(conversationId));
    const set=activeViews.get(userId)||new Set();set.add(conversationId);activeViews.set(userId,set);
    const newer=payload.afterSequence?await chat.listMessages(conversationId,userId,{after:payload.afterSequence,limit:100}):{messages:[]};
    const counts=await getConversationPresence(access.conversation,userId),data={conversationId,messages:newer.messages,memberCount:counts.memberCount,onlineCount:counts.onlineCount};
    socket.emit("conversation:joined",data);namespace.to(room(conversationId)).emit("conversation:presence",counts);
    ack?.({success:true,data,...data});debug("conversation joined",{userId,conversationId,memberCount:data.memberCount,onlineCount:data.onlineCount});
  }catch(error){ackError(ack,error);}});

  socket.on("conversation:leave",(payload={},ack)=>{socket.leave(room(payload.conversationId));activeViews.get(userId)?.delete(String(payload.conversationId));stopTyping(payload.conversationId);ack?.({success:true,data:{}});});
  socket.on("message:send",async(payload={},ack)=>{try{assertRate(`message:${userId}`,30,60000);const message=await chat.sendMessage(payload.conversationId,userId,payload,{isActivelyViewing:viewing});namespace.to(room(message.conversation)).emit("message:new",message);ack?.({success:true,data:{message}});}catch(error){ackError(ack,error);}});
  socket.on("message:edit",async(payload={},ack)=>{try{const message=await chat.editMessage(payload.messageId,userId,payload.content);namespace.to(room(message.conversation)).emit("message:updated",message);ack?.({success:true,data:{message}});}catch(error){ackError(ack,error);}});
  socket.on("message:delete",async(payload={},ack)=>{try{const message=await chat.deleteMessage(payload.messageId,userId);namespace.to(room(message.conversation)).emit("message:deleted",message);ack?.({success:true,data:{message}});}catch(error){ackError(ack,error);}});
  socket.on("message:read",async(payload={},ack)=>{try{const state=await chat.markRead(payload.conversationId,userId,payload.sequence);namespace.to(room(payload.conversationId)).emit("message:read_updated",{conversationId:payload.conversationId,userId,...state});ack?.({success:true,data:state});}catch(error){ackError(ack,error);}});
  for(const [event,remove] of [["reaction:add",false],["reaction:remove",true]])socket.on(event,async(payload={},ack)=>{try{const result=await chat.setReaction(payload.messageId,userId,payload.emoji,remove);namespace.to(room(result.conversationId)).emit("reaction:updated",{messageId:payload.messageId,reactions:result.reactions});ack?.({success:true,data:{reactions:result.reactions}});}catch(error){ackError(ack,error);}});
  socket.on("typing:start",async(payload={},ack)=>{try{assertRate(`typing:${userId}:${payload.conversationId}`,1,900);await permission.assertCanSendMessage(payload.conversationId,userId);const key=`${payload.conversationId}:${userId}`;clearTimeout(typing.get(key));socket.to(room(payload.conversationId)).emit("typing:started",{conversationId:payload.conversationId,user:{_id:userId,username:socket.user.username}});typing.set(key,setTimeout(()=>stopTyping(payload.conversationId),5000));ack?.({success:true,data:{}});}catch(error){ackError(ack,error);}});
  socket.on("typing:stop",payload=>stopTyping(payload?.conversationId));

  socket.on("presence:subscribe",async(payload={},ack)=>{try{const access=await permission.assertCanViewConversation(payload.conversationId,userId),target=presence.normalizeId(payload.userId),participants=await getAuthorizedConversationParticipants(access.conversation,{viewerId:userId});if(!participants.some(value=>presence.normalizeId(value.user)===target))throw permission.error("FORBIDDEN","Presence is unavailable");if(await Block.exists({$or:[{blocker:userId,blocked:target},{blocker:target,blocked:userId}]}))throw permission.error("FORBIDDEN","Presence is unavailable");socket.join(`presence:${target}`);const data={userId:target,online:presence.isOnline(target)};socket.emit("presence:changed",data);ack?.({success:true,data});}catch(error){ackError(ack,error);}});
  socket.on("presence:unsubscribe",(payload={},ack)=>{socket.leave(`presence:${presence.normalizeId(payload.userId)}`);ack?.({success:true,data:{}});});

  socket.on("disconnect",reason=>{const conversations=[...(activeViews.get(userId)||[])];for(const conversationId of conversations)stopTyping(conversationId,false);activeViews.delete(userId);presence.disconnect(userId,socket.id,{onOffline:async data=>{namespace.to(`presence:${userId}`).emit("presence:changed",{...data,online:false});for(const conversationId of conversations){try{const access=await permission.assertCanViewConversation(conversationId,userId);await broadcastConversationPresence(access.conversation);}catch{}}}});debug("socket disconnected",{userId,reason,socketCount:presence.count(userId)});});
}

module.exports={installChatHandlers,getConversationPresence,typing,activeViews,viewing};

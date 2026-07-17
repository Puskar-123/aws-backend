const test=require("node:test");
const assert=require("node:assert/strict");
const jwt=require("jsonwebtoken");
const mongoose=require("mongoose");
const {tokenFrom,socketAuth}=require("../sockets/socketAuth");
const {createDirectKey,LIMITS}=require("../constants/chatConstants");
const chat=require("../services/chatService");
const permission=require("../services/chatPermissionService");
const attachment=require("../services/chatAttachmentService");
const rate=require("../services/chatRateLimitService");
const presence=require("../services/presenceService");
const lifecycle=require("../services/chatLifecycleService");
const Conversation=require("../models/conversationModel");
const Member=require("../models/conversationMemberModel");
const Message=require("../models/chatMessageModel");

test("chat schemas declare conversation identity, message sequence, idempotency, and membership indexes",()=>{
  const indexes=model=>model.schema.indexes().map(([value])=>JSON.stringify(value));
  assert.ok(indexes(Conversation).includes(JSON.stringify({type:1,directKey:1})));
  assert.ok(indexes(Member).includes(JSON.stringify({conversation:1,user:1})));
  assert.ok(indexes(Message).includes(JSON.stringify({conversation:1,sequence:1})));
  assert.ok(indexes(Message).includes(JSON.stringify({conversation:1,clientMessageId:1,sender:1})));
});

test("socket authentication accepts auth and Bearer tokens and rejects a missing JWT",async()=>{
  assert.equal(tokenFrom({handshake:{auth:{token:"abc"},headers:{}}}),"abc");
  assert.equal(tokenFrom({handshake:{auth:{},headers:{authorization:"Bearer xyz"}}}),"xyz");
  const middleware=socketAuth({secret:"test-secret",UserModel:{findById(id){return{select(){return{lean:async()=>({_id:id,username:"ada"})}}}}}});
  const socket={handshake:{auth:{token:jwt.sign({id:"507f1f77bcf86cd799439011"},"test-secret")},headers:{}}};
  await new Promise((resolve,reject)=>middleware(socket,error=>error?reject(error):resolve()));
  assert.equal(socket.userId,"507f1f77bcf86cd799439011");
  await new Promise(resolve=>socketAuth({secret:"test-secret"})({handshake:{auth:{},headers:{}}},error=>{assert.equal(error.data.error,"AUTHENTICATION_REQUIRED");resolve();}));
});

test("direct conversation keys are order-independent and self messaging is rejected",async()=>{
  assert.equal(createDirectKey("b","a"),createDirectKey("a","b"));
  await assert.rejects(permission.assertCanCreateDirectConversation("a","a",{BlockModel:{exists:async()=>false}}),error=>error.code==="CANNOT_MESSAGE_SELF");
});

test("blocked users cannot create direct conversations",async()=>{
  await assert.rejects(permission.assertCanCreateDirectConversation("a","b",{BlockModel:{exists:async()=>true}}),error=>error.code==="USER_BLOCKED");
});

test("unread arithmetic is bounded at zero",()=>{
  assert.equal(chat.unread(12,7),5);
  assert.equal(chat.unread(2,9),0);
  assert.equal(chat.unread(undefined,undefined),0);
});

test("attachment validation enforces size, MIME, and executable signatures without exposing keys",()=>{
  assert.equal(attachment.validateFile({buffer:Buffer.from("hello"),size:5,originalname:"notes.txt",mimetype:"text/plain"}),"notes.txt");
  assert.throws(()=>attachment.validateFile({buffer:Buffer.alloc(LIMITS.attachmentBytes+1),size:LIMITS.attachmentBytes+1,originalname:"large.txt",mimetype:"text/plain"}),error=>error.code==="ATTACHMENT_TOO_LARGE");
  assert.throws(()=>attachment.validateFile({buffer:Buffer.from("MZbad"),size:5,originalname:"safe.txt",mimetype:"application/octet-stream"}),error=>error.code==="ATTACHMENT_TYPE_NOT_ALLOWED");
  assert.throws(()=>attachment.validateFile({buffer:Buffer.from("x"),size:1,originalname:"run.exe",mimetype:"application/octet-stream"}),error=>error.code==="ATTACHMENT_TYPE_NOT_ALLOWED");
});

test("rate limiting permits only the configured count in a window",()=>{
  rate.buckets.clear();
  assert.equal(rate.consume("chat-test",2,1000,10),true);
  assert.equal(rate.consume("chat-test",2,1000,11),true);
  assert.equal(rate.consume("chat-test",2,1000,12),false);
  assert.equal(rate.consume("chat-test",2,1000,1011),true);
});

test("multiple sockets preserve online state until final disconnect",async()=>{
  presence.sockets.clear();
  presence.connect("user","one");presence.connect("user","two");
  assert.equal(presence.count("user"),2);
  presence.disconnect("user","one",{delay:0,UserModel:{updateOne:async()=>{} }});
  assert.equal(presence.isOnline("user"),true);
  await new Promise(resolve=>{presence.disconnect("user","two",{delay:0,UserModel:{updateOne:async()=>{}},onOffline:resolve});});
  assert.equal(presence.isOnline("user"),false);
});

test("repository deletion lifecycle archives repository, issue, and pull-request conversations",async()=>{
  const calls=[];
  const result=await lifecycle.archiveRepositoryChat("repo",{
    IssueModel:{find:()=>({select:()=>({lean:async()=>[{_id:"issue"}]})})},
    PullModel:{find:()=>({select:()=>({lean:async()=>[{_id:"pull"}]})})},
    ConversationModel:{updateMany:async(filter,update)=>{calls.push({filter,update});return{modifiedCount:3};}},
  });
  assert.equal(result.modifiedCount,3);
  assert.equal(calls[0].update.$set.isArchived,true);
  assert.deepEqual(calls[0].filter.$or[1].issue.$in,["issue"]);
  assert.deepEqual(calls[0].filter.$or[2].pullRequest.$in,["pull"]);
});

test("chat routes are authenticated and expose reports, attachments, and conversation APIs",()=>{
  const router=require("../routes/chat.router");
  const paths=router.stack.filter(layer=>layer.route).map(layer=>`${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  assert.ok(paths.includes("GET /conversations"));
  assert.ok(paths.includes("POST /attachments"));
  assert.ok(paths.includes("GET /reports"));
  assert.ok(paths.includes("PATCH /reports/:reportId"));
});

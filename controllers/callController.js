const crypto=require("crypto"),callService=require("../services/callService"),permission=require("../services/callPermissionService"),{assertRate}=require("../services/chatRateLimitService");
const sendError=(res,error)=>res.status(error.status||500).json({success:false,error:error.code||"CALL_ERROR",message:error.status?error.message:"Unable to complete call request"});
const endpoint=fn=>async(req,res)=>{try{return res.json({success:true,...await fn(req,res)});}catch(error){return sendError(res,error);}};
const history=endpoint(async req=>({calls:await callService.getCallHistory(req.user.id)}));
const active=endpoint(async req=>({call:await callService.getActiveCallForUser(req.user.id)}));
const details=endpoint(async req=>({call:await callService.getCallById(req.params.callId,req.user.id)}));
const iceServers=endpoint(async req=>{assertRate(`turn:${req.user.id}`,30,3600000);const secret=process.env.TURN_SHARED_SECRET,urls=String(process.env.TURN_URLS||"").split(",").map(value=>value.trim()).filter(Boolean);if(!secret||!urls.length)throw permission.error("TURN_CONFIGURATION_UNAVAILABLE","Relay configuration is unavailable",503);const ttl=Math.max(60,Math.min(3600,Number(process.env.TURN_CREDENTIAL_TTL_SECONDS)||600)),username=`${Math.floor(Date.now()/1000)+ttl}:${req.user.id}`,credential=crypto.createHmac("sha1",secret).update(username).digest("base64");return{iceServers:[{urls,username,credential,credentialType:"password"}],expiresIn:ttl};});
module.exports={history,active,details,iceServers,sendError};

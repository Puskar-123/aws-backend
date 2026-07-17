const User=require("../models/userModel");

const userSockets=new Map(),timers=new Map();
const normalizeId=value=>{if(!value)return null;if(typeof value==="string")return value;if(value._id)return String(value._id);if(value.id)return String(value.id);return String(value);};

function addSocket(userId,socketId){const key=normalizeId(userId);if(!key)return 0;clearTimeout(timers.get(key));timers.delete(key);const values=userSockets.get(key)||new Set();values.add(String(socketId));userSockets.set(key,values);return values.size;}
function removeSocket(userId,socketId){const key=normalizeId(userId),values=userSockets.get(key);if(!values)return false;values.delete(String(socketId));if(values.size)return true;userSockets.delete(key);return false;}
const isOnline=userId=>(userSockets.get(normalizeId(userId))?.size||0)>0;
const count=userId=>userSockets.get(normalizeId(userId))?.size||0;
const getOnlineUserIds=(userIds=[])=>[...new Set(userIds.map(normalizeId).filter(Boolean))].filter(isOnline);
const getOnlineCount=(userIds=[])=>getOnlineUserIds(userIds).length;

function disconnect(userId,socketId,{delay=1500,onOffline=()=>{},UserModel=User}={}){const key=normalizeId(userId);if(removeSocket(key,socketId))return true;if(!key)return false;timers.set(key,setTimeout(async()=>{if(isOnline(key))return;timers.delete(key);const lastSeenAt=new Date();await UserModel.updateOne({_id:key},{$set:{lastSeenAt}}).catch(()=>{});await onOffline({userId:key,lastSeenAt});},delay));return false;}

module.exports={normalizeId,addSocket,removeSocket,connect:addSocket,disconnect,isOnline,count,getOnlineUserIds,getOnlineCount,sockets:userSockets,userSockets,timers};

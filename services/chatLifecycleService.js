const Conversation=require("../models/conversationModel");
const Issue=require("../models/issueModel");
const PullRequest=require("../models/pullRequestModel");

async function archiveRepositoryChat(repositoryId,{ConversationModel=Conversation,IssueModel=Issue,PullModel=PullRequest}={}){
  const [issues,pulls]=await Promise.all([
    IssueModel.find({repository:repositoryId}).select("_id").lean(),
    PullModel.find({repository:repositoryId}).select("_id").lean(),
  ]);
  return ConversationModel.updateMany({$or:[
    {repository:repositoryId},
    {issue:{$in:issues.map(value=>value._id)}},
    {pullRequest:{$in:pulls.map(value=>value._id)}},
  ]},{$set:{isArchived:true,archivedAt:new Date()}});
}

module.exports={archiveRepositoryChat};

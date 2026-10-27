import type { VisionSaveReceipt, VisionSaveRequest, VisionSaveReview } from '../api/client';

type ReviewButton = {text:string;style?:'cancel';onPress?:()=>void};
export type VisionRecoveryActions = {
 alert:(title:string,message:string,buttons:ReviewButton[])=>void;
 review:(input:VisionSaveRequest)=>Promise<VisionSaveReview>;
 newAttemptKey:()=>string;
 submit:(input:VisionSaveRequest)=>Promise<boolean>;
};
export function offerVisionSaveRecovery(input:VisionSaveRequest,receipt:VisionSaveReceipt,actions:VisionRecoveryActions):boolean {
 if(receipt.status!=='rejected'||receipt.recoveryAvailable!==true)return false;
 let reviewing=false;
 actions.alert('Save rejected before dispatch',(receipt.reason??'The source changed before saving.')+' Your selected content is retained. Refresh and review it before starting a new save attempt.',[
  {text:'Keep selection',style:'cancel'},
  {text:'Refresh and review',onPress:()=>{
   if(reviewing)return;
   reviewing=true;
   void (async()=>{
    try{
     const review=await actions.review(input);
     if(review.status!=='ready'){
      actions.alert('New attempt unavailable',review.reason,[{text:'Keep selection',style:'cancel'}]);return;
     }
     let submitted=false;
     actions.alert('Review refreshed source','Selected content (unchanged):\n'+input.body+'\n\nCurrent source:\n'+review.sourceContents.join('\n\n')+'\n\nNothing has been saved. Start a new save attempt only after reviewing this source. Current source access and Vision permission will be checked again.',[
      {text:'Keep selection',style:'cancel'},
      {text:'Start new save attempt',onPress:()=>{
       if(submitted)return;
       submitted=true;
       void actions.submit({...input,sourceRefs:review.sourceRefs,idempotencyKey:actions.newAttemptKey(),retryOf:input.idempotencyKey});
      }},
     ]);
    }catch{
     actions.alert('Review unavailable','Your selection is retained. No new save attempt was started.',[{text:'Keep selection',style:'cancel'}]);
    }finally{reviewing=false;}
   })();
  }},
 ]);
 return true;
}

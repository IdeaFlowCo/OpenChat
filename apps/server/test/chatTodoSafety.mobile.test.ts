import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({getAsk:vi.fn(),updateAsk:vi.fn(),deleteAsk:vi.fn(),saveAsk:vi.fn(),listAsks:vi.fn()}));
vi.mock('../../mobile/src/api/client',()=>({api:m}));
vi.mock('../../mobile/src/services/conversationPanel',()=>({announceTodosChanged:vi.fn(),onTodosChanged:vi.fn()}));
import {addChatTodo,deleteChatTodo,listChatTodos} from '../../mobile/src/services/chatTodos';
const ask:any={id:'a',text:'Same task',fromMe:true,carrier:{kind:'self'},status:'open',exposure:'only_me',publication:null,placements:[{kind:'conversation',conversationId:'room'},{kind:'self'}],sources:[],createdAt:'2026-11-15',closedAt:null};
beforeEach(()=>{vi.clearAllMocks();m.getAsk.mockResolvedValue({ask});m.updateAsk.mockResolvedValue({ask});});
it('removes only the chat placement, preserving the underlying ask',async()=>{
 await deleteChatTodo('room','a');expect(m.deleteAsk).not.toHaveBeenCalled();expect(m.updateAsk).toHaveBeenCalledWith('a',{placements:['self']});
});
it.each([{exposure:'friends'},{publication:{state:'active'}}])('refuses shared or published ask adoption and removal (%j)',async patch=>{
 const shared={...ask,...patch};m.getAsk.mockResolvedValue({ask:shared});m.saveAsk.mockResolvedValue({ask:shared,created:false});
 await expect(deleteChatTodo('room','a')).rejects.toThrow('shared or published');
 await expect(addChatTodo({conversationId:'room',text:'Same task'})).rejects.toThrow('shared or published');expect(m.updateAsk).not.toHaveBeenCalled();expect(m.deleteAsk).not.toHaveBeenCalled();
});
it('requests the chat placement at the server before pagination',async()=>{m.listAsks.mockResolvedValue({asks:[],truncated:false});await listChatTodos('room');expect(m.listAsks).toHaveBeenCalledWith({direction:'for_me',status:'all',limit:200,conversationId:'room'});});

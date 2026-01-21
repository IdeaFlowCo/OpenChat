import { useState } from 'react';
import { useChat } from '../contexts/ChatContext';
import { ConversationList } from './ConversationList';
import { PresenceIndicator } from './PresenceIndicator';

export function ChatSidebar() {
  const { contacts, loadContacts, createConversation, setActiveConversation, presence, currentUser } = useChat();
  const [showContacts, setShowContacts] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const handleNewChat = async () => {
    await loadContacts();
    setShowContacts(true);
  };

  const handleSelectContact = async (contactId: string) => {
    const conv = await createConversation([contactId]);
    setActiveConversation(conv.id);
    setShowContacts(false);
    setSearchTerm('');
  };

  const filteredContacts = contacts.filter(c =>
    c.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.email?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="w-80 border-r border-gray-200 flex flex-col bg-white">
      {/* Header */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-semibold">Chats</h1>
          <button
            onClick={handleNewChat}
            className="px-3 py-1 text-sm bg-blue-500 text-white rounded-full hover:bg-blue-600"
          >
            New
          </button>
        </div>

        {/* Current user status */}
        {currentUser && (
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <PresenceIndicator status="available" size="sm" />
            <span>{currentUser.email}</span>
          </div>
        )}
      </div>

      {/* Contact picker modal/dropdown */}
      {showContacts ? (
        <div className="flex-1 flex flex-col">
          <div className="p-3 border-b border-gray-200">
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => setShowContacts(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                ← Back
              </button>
              <span className="font-medium">Select Contact</span>
            </div>
            <input
              type="text"
              placeholder="Search contacts..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            {filteredContacts.length === 0 ? (
              <div className="p-4 text-center text-gray-500">
                {contacts.length === 0 ? 'No contacts found' : 'No matches'}
              </div>
            ) : (
              filteredContacts.map((contact) => {
                const contactPresence = presence.get(contact.id);

                return (
                  <div
                    key={contact.id}
                    onClick={() => handleSelectContact(contact.id)}
                    className="p-3 cursor-pointer hover:bg-gray-50 border-b border-gray-100"
                  >
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <div className="w-10 h-10 rounded-full bg-gray-300 flex items-center justify-center text-gray-600 font-medium">
                          {(contact.name || contact.email).charAt(0).toUpperCase()}
                        </div>
                        <div className="absolute -bottom-0.5 -right-0.5">
                          <PresenceIndicator
                            status={contactPresence?.status || contact.presenceStatus}
                            size="sm"
                          />
                        </div>
                      </div>
                      <div>
                        <div className="font-medium">{contact.name || contact.email}</div>
                        {contactPresence?.statusMessage && (
                          <div className="text-sm text-gray-500 truncate">
                            {contactPresence.statusMessage}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : (
        <ConversationList />
      )}
    </div>
  );
}

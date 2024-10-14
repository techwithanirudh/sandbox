import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '../ui/button';
import { Send, StopCircle, Copy, Check, ChevronDown, ChevronUp, X, CornerUpLeft, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import LoadingDots from '../ui/LoadingDots';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  context?: string;
}

export default function AIChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [context, setContext] = useState<string | null>(null);
  const [isContextExpanded, setIsContextExpanded] = useState(false);
  const [expandedMessageIndex, setExpandedMessageIndex] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    if (chatContainerRef.current) {
      setTimeout(() => {
        chatContainerRef.current?.scrollTo({
          top: chatContainerRef.current.scrollHeight,
          behavior: 'smooth'
        });
      }, 100);
    }
  };

  const handleSend = useCallback(async () => {
    if (input.trim() === '' && !context) return;

    const newMessage: Message = { 
      role: 'user', 
      content: input,
      context: context || undefined
    };
    setMessages(prev => [...prev, newMessage]);
    setInput('');
    setIsContextExpanded(false);
    setIsGenerating(true);
    setIsLoading(true);

    abortControllerRef.current = new AbortController();

    try {
      const queryParams = new URLSearchParams({
        instructions: input,
        ...(context && { context })
      });
      const response = await fetch(`http://127.0.0.1:8787/api?${queryParams}`, {
        method: 'GET',
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error('Failed to get AI response');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      const assistantMessage: Message = { role: 'assistant', content: '' };
      setMessages(prev => [...prev, assistantMessage]);
      setIsLoading(false);

      let buffer = '';
      const updateInterval = 100; // Update every 100ms
      let lastUpdateTime = Date.now();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const currentTime = Date.now();
          if (currentTime - lastUpdateTime > updateInterval) {
            setMessages(prev => {
              const updatedMessages = [...prev];
              const lastMessage = updatedMessages[updatedMessages.length - 1];
              lastMessage.content = buffer;
              return updatedMessages;
            });
            lastUpdateTime = currentTime;
          }
        }

        // Final update to ensure all content is displayed
        setMessages(prev => {
          const updatedMessages = [...prev];
          const lastMessage = updatedMessages[updatedMessages.length - 1];
          lastMessage.content = buffer;
          return updatedMessages;
        });
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('Generation aborted');
      } else {
        console.error('Error fetching AI response:', error);
        const errorMessage: Message = { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' };
        setMessages(prev => [...prev, errorMessage]);
      }
    } finally {
      setIsGenerating(false);
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  }, [input, context]);

  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1000); // Reset after 1 seconds
    });
  };

  const askAboutCode = (code: string) => {
    setContext(`Regarding this code:\n${code}`);
    setIsContextExpanded(false);
  };

  const removeContext = () => {
    setContext(null);
    setIsContextExpanded(false);
  };

  return (
    <div className="flex flex-col h-screen w-full">
      <span className="text-muted-foreground/50 font-medium p-2">CHAT</span>
      <div ref={chatContainerRef} className="flex-grow overflow-y-auto p-4 space-y-4">
        {messages.map((message, messageIndex) => (
          <div key={messageIndex} className="text-left">
            <div className={`inline-block p-2 rounded-lg ${
              message.role === 'user' 
                ? 'bg-[#262626] text-white' 
                : 'bg-transparent text-white'
              } max-w-full`}>
              {message.context && (
                <div className="mb-2 bg-input rounded-lg">
                  <div 
                    className="flex justify-between items-center cursor-pointer"
                    onClick={() => setExpandedMessageIndex(expandedMessageIndex === messageIndex ? null : messageIndex)}
                  >
                    <span className="text-sm text-gray-300">
                      Context 
                    </span>
                    {expandedMessageIndex === messageIndex ? (
                      <ChevronUp size={16} />
                    ) : (
                      <ChevronDown size={16} />
                    )}
                  </div>
                  {expandedMessageIndex === messageIndex && (
                    <div className="relative">
                      <div className="absolute top-0 right-0 flex p-1">
                        <Button
                          onClick={() => copyToClipboard(message.context!.replace(/^Regarding this code:\n/, ''), messageIndex)}
                          size="sm"
                          variant="ghost"
                          className="p-1 h-6"
                        >
                          {copiedIndex === messageIndex ? (
                            <Check className="w-4 h-4 text-green-500" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </Button>
                      </div>
                      {(() => {
                        // need to fix the language detection
                        const code = message.context!.replace(/^Regarding this code:\n/, '');
                        const match = /language-(\w+)/.exec(code);
                        const language = match ? match[1] : 'typescript';
                        return (
                          <div className="pt-6">
                            <SyntaxHighlighter
                              style={vscDarkPlus as any}
                              language={language}
                              PreTag="div"
                              customStyle={{
                                margin: 0,
                                padding: '0.5rem',
                                fontSize: '0.875rem',
                              }}
                            >
                              {code}
                            </SyntaxHighlighter>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
              {message.role === 'assistant' ? (
                <ReactMarkdown
                  components={{
                    code({node, className, children, ...props}) {
                      const match = /language-(\w+)/.exec(className || '');
                      const language = match ? match[1] : '';
                      return match ? (
                        <div className="relative border border-input rounded-md my-4">
                          <div className="absolute top-0 left-0 px-2 py-1 text-xs font-semibold text-gray-200 bg-#1e1e1e rounded-tl">
                            {language}
                          </div>
                          <div className="absolute top-0 right-0 flex">
                            <Button
                              onClick={() => copyToClipboard(String(children), messageIndex)}
                              size="sm"
                              variant="ghost"
                              className="p-1 h-6"
                            >
                              {copiedIndex === messageIndex ? (
                                <Check className="w-4 h-4 text-green-500" />
                              ) : (
                                <Copy className="w-4 h-4" />
                              )}
                            </Button>
                            <Button
                              onClick={() => askAboutCode(String(children))}
                              size="sm"
                              variant="ghost"
                              className="p-1 h-6"
                            >
                              <CornerUpLeft className="w-4 h-4" />
                            </Button>
                          </div>
                          <div className="pt-6">
                            <SyntaxHighlighter
                              style={vscDarkPlus as any}
                              language={match[1]}
                              PreTag="div"
                              customStyle={{
                                margin: 0,
                                padding: '0.5rem',
                                fontSize: '0.875rem',
                              }}
                            >
                              {String(children).replace(/\n$/, '')}
                            </SyntaxHighlighter>
                          </div>
                        </div>
                      ) : (
                        <code className={className} {...props}>
                          {children}
                        </code>
                      );
                    },
                    p({children}) {
                      return <p className="mb-4 whitespace-pre-line">{children}</p>;
                    },
                    ul({children}) {
                      return <ul className="list-disc pl-6 mb-4">{children}</ul>;
                    },
                    ol({children}) {
                      return <ol className="list-decimal pl-6 mb-4">{children}</ol>;
                    },
                    li({children}) {
                      return <li className="mb-2">{children}</li>;
                    },
                  }}
                >
                  {message.content}
                </ReactMarkdown>
              ) : (
                <div className="whitespace-pre-wrap">{message.content}</div>
              )}
            </div>
          </div>
        ))}
        {isLoading && (
            <LoadingDots />
        )}
      </div>
      <div className="p-4 border-t mb-14">
        {context && (
          <div className="mb-2 bg-input p-2 rounded-lg">
            <div className="flex justify-between items-center">
              <div 
                className="flex-grow cursor-pointer" 
                onClick={() => setIsContextExpanded(!isContextExpanded)}
              >
                <span className="text-sm text-gray-300">
                  Context
                </span>
              </div>
              <div className="flex items-center">
                {isContextExpanded ? (
                  <ChevronUp size={16} className="cursor-pointer" onClick={() => setIsContextExpanded(false)} />
                ) : (
                  <ChevronDown size={16} className="cursor-pointer" onClick={() => setIsContextExpanded(true)} />
                )}
                <X 
                  size={16} 
                  className="ml-2 cursor-pointer text-gray-400 hover:text-gray-200" 
                  onClick={removeContext}
                />
              </div>
            </div>
            {isContextExpanded && (
              <textarea
                value={context.replace(/^Regarding this code:\n/, '')}
                onChange={(e) => setContext(e.target.value)}
                className="w-full mt-2 p-2 bg-#1e1e1e text-white rounded"
                rows={5}
              />
            )}
          </div>
        )}
        <div className="flex space-x-2 min-w-0">
          <input 
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && !isGenerating && handleSend()}
            className="flex-grow p-2 border rounded-lg min-w-0 bg-input"
            placeholder={context ? "Add more context or ask a question..." : "Type your message..."}
            disabled={isGenerating}
          />
          {isGenerating ? (
            <Button onClick={handleStopGeneration} variant="destructive" size="icon" className="h-10 w-10">
              <StopCircle className="w-4 h-4" />
            </Button>
          ) : (
            <Button onClick={handleSend} disabled={isGenerating} size="icon" className="h-10 w-10">
              <Send className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
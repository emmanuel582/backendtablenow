import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';

const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY!,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const embeddingModel = genAI.getGenerativeModel({ model: 'embedding-001' });

export class RAGService {
    private index: any;
    private readonly indexName = process.env.PINECONE_INDEX_NAME || 'tablenow-knowledge';

    constructor() {
        this.initializeIndex();
    }

    /**
     * Initialize Pinecone index
     */
    private async initializeIndex() {
        try {
            this.index = pinecone.Index(this.indexName);
            console.log('✅ Pinecone index initialized:', this.indexName);
        } catch (error) {
            console.error('❌ Error initializing Pinecone:', error);
        }
    }

    /**
     * Extract text from uploaded document
     */
    async extractTextFromDocument(filePath: string, fileType: string): Promise<string> {
        try {
            if (fileType === 'application/pdf' || filePath.endsWith('.pdf')) {
                const dataBuffer = fs.readFileSync(filePath);
                const data = await pdf(dataBuffer);
                return data.text;
            } else if (fileType.includes('word') || filePath.endsWith('.docx') || filePath.endsWith('.doc')) {
                const result = await mammoth.extractRawText({ path: filePath });
                return result.value;
            } else if (fileType === 'text/plain' || filePath.endsWith('.txt')) {
                return fs.readFileSync(filePath, 'utf-8');
            } else {
                throw new Error('Unsupported file type');
            }
        } catch (error: any) {
            console.error('Error extracting text from document:', error);
            throw error;
        }
    }

    /**
     * Split text into chunks for better embedding
     */
    private splitTextIntoChunks(text: string, chunkSize: number = 1000, overlap: number = 200): string[] {
        const chunks: string[] = [];
        let startIndex = 0;

        while (startIndex < text.length) {
            const endIndex = Math.min(startIndex + chunkSize, text.length);
            const chunk = text.substring(startIndex, endIndex);
            chunks.push(chunk.trim());
            startIndex += chunkSize - overlap;
        }

        return chunks.filter(chunk => chunk.length > 50); // Filter out very small chunks
    }

    /**
     * Generate embeddings using Gemini
     */
    private async generateEmbedding(text: string): Promise<number[]> {
        try {
            const result = await embeddingModel.embedContent(text);
            return result.embedding.values;
        } catch (error: any) {
            console.error('Error generating embedding:', error);
            throw error;
        }
    }

    /**
     * Process and store document in Pinecone
     */
    async processAndStoreDocument(
        restaurantId: string,
        documentType: 'menu' | 'faq' | 'policies',
        filePath: string,
        fileType: string
    ): Promise<void> {
        try {
            console.log(`📄 Processing ${documentType} for restaurant ${restaurantId}...`);

            // Extract text from document
            const text = await this.extractTextFromDocument(filePath, fileType);
            console.log(`✅ Extracted ${text.length} characters from document`);

            // Split into chunks
            const chunks = this.splitTextIntoChunks(text);
            console.log(`✅ Split into ${chunks.length} chunks`);

            // Generate embeddings and store in Pinecone
            const vectors = [];
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const embedding = await this.generateEmbedding(chunk);

                vectors.push({
                    id: `${restaurantId}-${documentType}-${i}`,
                    values: embedding,
                    metadata: {
                        restaurantId,
                        documentType,
                        text: chunk,
                        chunkIndex: i,
                        totalChunks: chunks.length,
                        timestamp: new Date().toISOString()
                    }
                });

                // Batch upsert every 100 vectors
                if (vectors.length >= 100 || i === chunks.length - 1) {
                    await this.index.upsert(vectors);
                    console.log(`✅ Stored ${vectors.length} vectors in Pinecone`);
                    vectors.length = 0; // Clear array
                }
            }

            console.log(`✅ Successfully processed and stored ${documentType} for restaurant ${restaurantId}`);
        } catch (error: any) {
            console.error(`❌ Error processing document:`, error);
            throw error;
        }
    }

    /**
     * Query relevant information from documents
     */
    async queryDocuments(restaurantId: string, question: string, topK: number = 5): Promise<string[]> {
        try {
            // Generate embedding for the question
            const questionEmbedding = await this.generateEmbedding(question);

            // Query Pinecone
            const queryResponse = await this.index.query({
                vector: questionEmbedding,
                topK,
                filter: { restaurantId },
                includeMetadata: true
            });

            // Extract relevant text chunks
            const relevantChunks = queryResponse.matches.map((match: any) => match.metadata.text);

            return relevantChunks;
        } catch (error: any) {
            console.error('Error querying documents:', error);
            return [];
        }
    }

    /**
     * Generate answer using Gemini with RAG context
     */
    async generateAnswer(restaurantId: string, question: string, restaurantData: any): Promise<string> {
        try {
            // Get relevant context from documents
            const relevantChunks = await this.queryDocuments(restaurantId, question, 3);

            // Build context
            const context = relevantChunks.length > 0
                ? `Relevant information from restaurant documents:\n${relevantChunks.join('\n\n')}`
                : 'No specific document information found.';

            // Generate answer using Gemini
            const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

            const prompt = `You are an AI assistant for ${restaurantData.name}, a ${restaurantData.cuisine_type || 'restaurant'}.

Restaurant Information:
- Name: ${restaurantData.name}
- Cuisine: ${restaurantData.cuisine_type || 'Various'}
- Address: ${restaurantData.address || 'Not specified'}
- Phone: ${restaurantData.phone || 'Not specified'}

${context}

Customer Question: ${question}

Please provide a helpful, accurate, and concise answer based on the restaurant information and documents above. If the information is not available in the documents, provide a general helpful response or suggest contacting the restaurant directly.

Answer:`;

            const result = await model.generateContent(prompt);
            const response = await result.response;
            return response.text();
        } catch (error: any) {
            console.error('Error generating answer:', error);
            return 'I apologize, but I am having trouble accessing that information right now. Please contact the restaurant directly for assistance.';
        }
    }

    /**
     * Delete all documents for a restaurant
     */
    async deleteRestaurantDocuments(restaurantId: string): Promise<void> {
        try {
            await this.index.deleteMany({
                filter: { restaurantId }
            });
            console.log(`✅ Deleted all documents for restaurant ${restaurantId}`);
        } catch (error: any) {
            console.error('Error deleting restaurant documents:', error);
            throw error;
        }
    }

    /**
     * Update document (delete old and add new)
     */
    async updateDocument(
        restaurantId: string,
        documentType: 'menu' | 'faq' | 'policies',
        filePath: string,
        fileType: string
    ): Promise<void> {
        try {
            // Delete old document chunks
            await this.index.deleteMany({
                filter: {
                    restaurantId,
                    documentType
                }
            });

            // Process and store new document
            await this.processAndStoreDocument(restaurantId, documentType, filePath, fileType);
        } catch (error: any) {
            console.error('Error updating document:', error);
            throw error;
        }
    }

    /**
     * Get document statistics for a restaurant
     */
    async getDocumentStats(restaurantId: string): Promise<any> {
        try {
            const stats = await this.index.describeIndexStats();

            // Query to count vectors for this restaurant
            const queryResponse = await this.index.query({
                vector: new Array(768).fill(0), // Dummy vector
                topK: 10000,
                filter: { restaurantId },
                includeMetadata: true
            });

            const documentTypes = {
                menu: 0,
                faq: 0,
                policies: 0
            };

            queryResponse.matches.forEach((match: any) => {
                const type = match.metadata.documentType;
                if (type in documentTypes) {
                    documentTypes[type as keyof typeof documentTypes]++;
                }
            });

            return {
                totalVectors: queryResponse.matches.length,
                byType: documentTypes,
                indexStats: stats
            };
        } catch (error: any) {
            console.error('Error getting document stats:', error);
            return null;
        }
    }
}

export default new RAGService();

# import sys
# import json

# try:
#     from youtube_comment_downloader import YoutubeCommentDownloader
# except ImportError:
#     # If the python package is not installed, output empty comments array cleanly
#     print(json.dumps([]))
#     sys.exit(0)

# def get_comments(url, limit=100):
#     try:
#         downloader = YoutubeCommentDownloader()
#         comments_generator = downloader.get_comments_from_url(url)
        
#         comments = []
#         for i, comment in enumerate(comments_generator):
#             if i >= limit:
#                 break
            
#             # Extract relevant info to match our schema and save payload size
#             comments.append({
#                 "text": comment.get("text", ""),
#                 "like_count": comment.get("votes", 0),  # the lib usually uses 'votes' for likes
#                 "reply_count": 0  # Not always reliable from this lib, but we keep it for schema
#             })
            
#         print(json.dumps(comments))
#     except Exception as e:
#         print(json.dumps({"error": str(e)}), file=sys.stderr)
#         sys.exit(1)

# if __name__ == "__main__":
#     if len(sys.argv) < 2:
#         print(json.dumps({"error": "Video URL required"}), file=sys.stderr)
#         sys.exit(1)
        
#     get_comments(sys.argv[1])

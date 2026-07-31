# The owner's private stream: their own steps and everything their agent
# produced, regardless of what they chose to show the room.
class UserChannel < ApplicationCable::Channel
  def subscribed = stream_from Broadcast.user_stream_for(current_user)
end

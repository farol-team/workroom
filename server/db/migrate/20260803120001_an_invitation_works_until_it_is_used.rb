class AnInvitationWorksUntilItIsUsed < ActiveRecord::Migration[8.1]
  # The code travelled out of band and is redeemed exactly once. A clock on top
  # of that expired links in inboxes without protecting anything the code and
  # the sign-in did not already protect (#164).
  def up
    remove_column :invitations, :expires_at
  end

  def down
    add_column :invitations, :expires_at, :datetime
  end
end
